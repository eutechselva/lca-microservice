const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const extract = require('extract-zip');
const Unrar = require('node-unrar-js');
const logger = require('../utils/logger');
const { HTTP_STATUS, formatResponse } = require('../utils/http');
const productService = require('../services/product.service');
const { retry, generateUUID, addQSToURL } = require('../utils/helpers');
const { getOriginUrl } = require('../middlewares/auth.middleware');
const { 
  classifyProduct, 
  classifyBOM, 
  classifyManufacturingProcess 
} = require('../utils/chatGPTUtils');

// Set up multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

/**
 * Bulk upload products from Excel/CSV
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const bulkUploadProducts = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(formatResponse(false, null, "No file uploaded"));
    }

    const Product = await productService.getProductModel(req);
    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
    let products = [];

    if (fileExtension === 'csv') {
      // Parse CSV file
      const csvContent = req.file.buffer.toString('utf8');
      const Papa = require('papaparse');
      const parseResult = Papa.parse(csvContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: header => header.trim()
      });
      
      if (parseResult.errors && parseResult.errors.length > 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(formatResponse(
          false,
          null,
          "CSV parsing error",
          { errors: parseResult.errors }
        ));
      }
      
      products = parseResult.data;
    } else {
      // Parse Excel file
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      
      // Use selected sheet if provided, otherwise use first sheet
      const sheetName = req.body.selectedSheet || workbook.SheetNames[0];
      
      if (!workbook.Sheets[sheetName]) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(formatResponse(
          false,
          null,
          `Sheet '${sheetName}' not found in Excel file`
        ));
      }
      
      const sheet = workbook.Sheets[sheetName];
      products = XLSX.utils.sheet_to_json(sheet);
    }

    if (!products || products.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(formatResponse(
        false,
        null,
        "No products found in the uploaded file"
      ));
    }

    // Get field mappings from request body
    const fieldMappings = {
      code: req.body.codeField,
      name: req.body.nameField,
      description: req.body.descriptionField,
      weight: req.body.weightField,
      countryOfOrigin: req.body.countryOfOriginField,
      supplierName: req.body.supplierNameField,
      category: req.body.categoryField,
      subCategory: req.body.subCategoryField
    };

    // Validate required field mappings
    const requiredMappings = ['code', 'name', 'description'];
    const missingMappings = requiredMappings.filter(field => !fieldMappings[field]);
    
    if (missingMappings.length > 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(formatResponse(
        false,
        null,
        "Required field mappings missing",
        { missingMappings: missingMappings.map(field => `${field}Field`) }
      ));
    }

    // Validate that mapped fields exist in the uploaded file
    if (products.length > 0) {
      const fileHeaders = Object.keys(products[0]);
      const missingFields = [];
      
      requiredMappings.forEach(schemaField => {
        const csvField = fieldMappings[schemaField];
        if (!fileHeaders.includes(csvField)) {
          missingFields.push(csvField);
        }
      });
      
      if (missingFields.length > 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(formatResponse(
          false,
          null,
          "Mapped fields not found in uploaded file",
          { 
            missingFields,
            availableFields: fileHeaders,
            fieldMappings
          }
        ));
      }
    }

    // Map products using field mappings from frontend
    const normalizedProducts = products.map(product => {
      const normalizedProduct = {};
      
      // Apply field mappings
      Object.keys(fieldMappings).forEach(schemaField => {
        const csvField = fieldMappings[schemaField];
        if (csvField && product.hasOwnProperty(csvField)) {
          normalizedProduct[schemaField] = product[csvField];
        }
      });
      
      // Add creation date and modified date
      normalizedProduct.createdDate = new Date();
      normalizedProduct.modifiedDate = new Date();
      
      return normalizedProduct;
    });

    // Validate required fields
    const validationErrors = {};
    const requiredFields = ['code', 'name', 'description'];
    
    normalizedProducts.forEach((product, index) => {
      requiredFields.forEach(field => {
        if (!product[field] || String(product[field]).trim() === '') {
          const csvField = fieldMappings[field];
          validationErrors[`Row ${index + 2}, ${field}`] = `is required (mapped from column '${csvField}')`;
        }
      });
    });

    if (Object.keys(validationErrors).length > 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json(formatResponse(
        false,
        null,
        "Validation failed",
        { 
          validationErrors,
          fieldMappings,
          note: "Check that the mapped columns contain valid data for all rows"
        }
      ));
    }

    // Insert products into MongoDB
    const savedProducts = await Product.insertMany(normalizedProducts);

    // Mark products as pending AI processing (will be processed after images upload)
    await Product.updateMany(
      { _id: { $in: savedProducts.map(p => p._id) } },
      { $set: { aiProcessingStatus: 'pending' } }
    );

    // Send response immediately - AI processing will happen after image upload
    res
      .status(HTTP_STATUS.CREATED)
      .json(formatResponse(true, savedProducts));
  } catch (error) {
    logger.error("Product upload error:", error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(formatResponse(
      false,
      null,
      `Failed to upload products: ${error.message}`
    ));
  }
};

// AI Processing Function - to be called after images are uploaded
const processProductAI = async (req) => {
  try {
    const account = req.get("x-iviva-account");

    const Product = await productService.getProductModel(req);
    
    // Find products that are pending AI processing
    const pendingProducts = await Product.find({ 
      aiProcessingStatus: 'pending' 
    });

    logger.info(`🔄 Starting AI processing for ${pendingProducts.length} products...`);

    // Process each product in the background
    pendingProducts.forEach(async (product) => {
      try {
        // Update status to processing
        await Product.updateOne(
          { _id: product._id },
          { $set: { aiProcessingStatus: 'processing' } }
        );

        // Wait for classification result
        const classifyResult = await retry(
          classifyProduct,
          [product.code, product.name, product.description, null, req],
          1
        );
        const classifyBOMResult = await retry(
          classifyBOM,
          [product.code, product.name, product.description, product.weight, null, req],
          1
        );
        const classifyManufacturingProcessResult = await retry(
          classifyManufacturingProcess,
          [product.code, product.name, product.description, classifyBOMResult, req],
          1
        );

        // Calculate emissions separately
        const co2EmissionRawMaterials = productService.calculateRawMaterialEmissions(
          classifyBOMResult,
          product.countryOfOrigin
        );
        const co2EmissionFromProcesses = productService.calculateProcessEmissions(
          classifyManufacturingProcessResult
        );

        const co2Emission = co2EmissionRawMaterials + co2EmissionFromProcesses;

        // Ensure result exists before updating
        if (classifyResult?.category && classifyResult?.subcategory) {
          await Product.updateOne(
            { _id: product._id },
            {
              $set: {
                category: classifyResult.category,
                subCategory: classifyResult.subcategory,
                materials: classifyBOMResult,
                productManufacturingProcess: classifyManufacturingProcessResult,
                co2Emission: co2Emission,
                co2EmissionRawMaterials: co2EmissionRawMaterials,
                co2EmissionFromProcesses: co2EmissionFromProcesses,
                aiProcessingStatus: 'completed',
                modifiedDate: Date.now(),
              },
            }
          );

          logger.info(
            `✅ Product ${product.code} AI processing completed with category: ${classifyResult.category}, subcategory: ${classifyResult.subcategory}`
          );
        } else {
          await Product.updateOne(
            { _id: product._id },
            { $set: { aiProcessingStatus: 'failed' } }
          );
          logger.warn(
            `⚠️ Product ${product.code} classification failed, marked as failed.`
          );
        }
      } catch (error) {
        await Product.updateOne(
          { _id: product._id },
          { $set: { aiProcessingStatus: 'failed' } }
        );
        logger.error(
          `❌ Failed to classify and update product ${product.code}:`,
          error.message
        );
      }
    });

    logger.info(`🚀 AI processing initiated for ${pendingProducts.length} products`);
  } catch (error) {
    logger.error("Error in processProductAI:", error);
  }
};

/**
 * Upload image to external API
 * @param {string} url - Upload URL
 * @param {string} filePath - Path to file
 */
async function uploadImageToExternalAPI(url, filePath) {
  const formData = new FormData();

  // Create a read stream instead of reading the entire file into memory
  formData.append("file", fs.createReadStream(filePath));

  try {
    const response = await axios.post(url, formData, {
      headers: {
        //Authorization: apiKey,
        ...formData.getHeaders(),
      },
      // Add timeout and max content length configs
      timeout: 30000,
      maxContentLength: Infinity,
    });

    logger.info(
      `Uploaded ${path.basename(filePath)} for product:`,
      response.data
    );
    return response.data;
  } catch (error) {
    // More detailed error logging
    logger.error(`Error uploading ${filePath}:`, {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
    });

    // Re-throw the error or return an error object
    throw error;
  }
}

/**
 * Extract ZIP file
 * @param {string} filePath - Path to ZIP file
 * @param {string} outputPath - Path to extract to
 */
const extractZipFile = async (filePath, outputPath) => {
  await extract(filePath, { dir: outputPath });
};

/**
 * Extract RAR file
 * @param {string} filePath - Path to RAR file
 * @param {string} outputPath - Path to extract to
 */
const extractRarFile = async (filePath, outputPath) => {
  const data = fs.readFileSync(filePath);
  const extractor = Unrar.createExtractorFromData(data);
  const extracted = extractor.extract();
  if (extracted[0].state === "SUCCESS") {
    extracted[1].files.forEach((file) => {
      const filePath = path.join(outputPath, file.fileHeader.name);
      fs.outputFileSync(filePath, file.extract()[1]);
    });
  }
};

/**
 * Bulk upload product images
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const bulkImageUpload = async (req, res) => {
  if (!req.file) {
    return res.status(400).json(formatResponse(
      false,
      null,
      "No file uploaded"
    ));
  }
  
  const account = req.account; // From validateAccount middleware
  const tempDir = path.join(__dirname, "../temp", account);
  const uploadedFilePath = path.join(tempDir, req.file.originalname);
  let extractionDir;

  try {
    const Product = await productService.getProductModel(req);

    // Ensure temp directory exists
    fs.ensureDirSync(tempDir);

    // Save uploaded file
    fs.writeFileSync(uploadedFilePath, req.file.buffer);

    // Create extraction directory
    extractionDir = path.join(
      tempDir,
      path.parse(req.file.originalname).name
    );
    fs.ensureDirSync(extractionDir);

    // Extract based on file type
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    if (fileExt === ".zip") {
      await extractZipFile(uploadedFilePath, extractionDir);
    } else if (fileExt === ".rar") {
      await extractRarFile(uploadedFilePath, extractionDir);
    } else {
      throw new Error("Unsupported file type. Only ZIP and RAR are allowed.");
    }

    // Process extracted folders
    const productFolders = fs.readdirSync(extractionDir);
    for (const productCode of productFolders) {
      let imageUploadedPaths = [];

      const productPath = path.join(extractionDir, productCode);
      if (fs.statSync(productPath).isDirectory()) {
        logger.info(`Processing images for product: ${productCode}`);

        const images = fs
          .readdirSync(productPath)
          .filter((file) => /\.(jpg|jpeg|png|gif)$/i.test(file));
        
        for (const image of images) {
          const imagePath = path.join(productPath, image);
          if (fs.statSync(imagePath).isFile()) {
            let name = `file-${generateUUID()}${path.extname(imagePath)}`;
            let hostURL = getOriginUrl(req) || "http://127.0.0.1:5000";
            let baseUrl = `${hostURL}/uploadcontent/notes/uploads/images/`;
            let url = addQSToURL(baseUrl, { filename: name });

            await uploadImageToExternalAPI(url, imagePath);
            let downloadUrl = hostURL + "/content/notes/uploads/images/" + name;
            imageUploadedPaths.push(downloadUrl);

            await Product.updateOne(
              { code: productCode },
              { $push: { images: downloadUrl } }
            );

            logger.info(`Uploaded: ${downloadUrl}`);
          }
        }
      }
    }

    // Trigger AI processing for pending products after images are uploaded
    await processProductAI(req);

    res.json(formatResponse(
      true,
      [],
      "Files uploaded and processed successfully"
    ));
  } catch (error) {
    logger.error("Error:", error);
    res.status(500).json(formatResponse(
      false,
      null,
      error.message
    ));
  } finally {
    // Cleanup temporary files
    try {
      // Only attempt cleanup if these variables were created in the try block
      if (typeof extractionDir !== 'undefined' && fs.existsSync(extractionDir)) {
        fs.removeSync(extractionDir);
        logger.info(`Removed extraction directory: ${extractionDir}`);
      }
      
      if (typeof uploadedFilePath !== 'undefined' && fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath);
        logger.info(`Removed uploaded file: ${uploadedFilePath}`);
      }
    } catch (cleanupError) {
      logger.error(`Error during cleanup: ${cleanupError.message}`);
    }
  }
};

// Manual AI Processing trigger endpoint
const triggerAIProcessing = async (req, res) => {
  try {
    await processProductAI(req);
    res.status(HTTP_STATUS.OK).json(formatResponse(
      true, 
      [], 
      "AI processing initiated for pending products"
    ));
  } catch (error) {
    logger.error("Manual AI processing trigger error:", error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(formatResponse(
      false,
      null,
      `Failed to trigger AI processing: ${error.message}`
    ));
  }
};

module.exports = {
  upload,  // Export multer middleware for routes
  bulkUploadProducts,
  bulkImageUpload,
  triggerAIProcessing
};