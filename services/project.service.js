const logger = require('../utils/logger');
const { getModel } = require('../config/database');
const projectSchema = require('../models/project_schema');
const productSchema = require('../models/product_schema');
const projectProductMapSchema = require('../models/project_product_map_schema');
const { getAccount } = require('../middlewares/auth.middleware');

/**
 * Get project model for the current account
 */
const getProjectModel = async (req) => {
  const account = getAccount(req);
  return getModel(account, projectSchema, "Project");
};

/**
 * Get product model for the current account
 */
const getProductModel = async (req) => {
  const account = getAccount(req);
  return getModel(account, productSchema, "Product");
};

/**
 * Get project-product mapping model for the current account
 */
const getProjectProductMapModel = async (req) => {
  const account = getAccount(req);
  return getModel(account, projectProductMapSchema, "ProjectProductMap");
};

/**
 * Get all projects
 */
const getAllProjects = async (req) => {
  const Project = await getProjectModel(req);
  return await Project.find().sort({ createdDate: -1 }).lean();
};

/**
 * Get project by ID
 */
const getProjectById = async (req, id) => {
  const Project = await getProjectModel(req);
  return await Project.findById(id);
};

/**
 * Create a new project
 */
const createProject = async (req) => {
  const Project = await getProjectModel(req);
  const project = new Project({
    ...req.body,
    createdDate: new Date(),
    modifiedDate: new Date()
  });
  return await project.save();
};

/**
 * Update a project
 */
const updateProject = async (req, id) => {
  const Project = await getProjectModel(req);
  return await Project.findByIdAndUpdate(
    id,
    { ...req.body, modifiedDate: new Date() },
    { new: true, runValidators: true }
  );
};

/**
 * Delete a project
 */
const deleteProject = async (req, id) => {
  const Project = await getProjectModel(req);
  return await Project.findByIdAndDelete(id);
};

/**
 * Delete all projects
 */
const deleteAllProjects = async (req) => {
  const Project = await getProjectModel(req);
  return await Project.deleteMany({});
};

/**
 * Calculate project impacts
 */
const calculateProjectImpacts = async (req, projectId) => {
  const Project = await getProjectModel(req);
  const ProductModel = await getProductModel(req);
  const ProjectProductMapModel = await getProjectProductMapModel(req);
  
  // Find the project
  const project = await Project.findById(projectId);
  if (!project) {
    return null;
  }
  
  // Find all product mappings related to the project
  const productMappings = await ProjectProductMapModel.find({
    projectID: projectId
  }).populate({
    path: 'productID',
    model: 'Product',
    select: 'name code countryOfOrigin description weight countryOfOrigin category subCategory images co2Emission co2EmissionRawMaterials co2EmissionFromProcesses materials productManufacturingProcess'
  });
  
  // Initialize totals
  let totalMaterialsImpact = 0;
  let totalManufacturingImpact = 0;
  let totalTransportationImpact = 0;
  
  const products = productMappings.map((mapping) => {
    // Check if productID exists
    if (!mapping.productID) {
      return {
        productName: 'Unknown',
        productCode: 'Unknown',
        materials: [],
        productManufacturingProcess: [],
        co2EmissionRawMaterials: 0,
        co2EmissionFromProcesses: 0,
        transportationEmission: 0,
        transportationLegs: [],
        packagingWeight: mapping.packagingWeight || 0,
        palletWeight: mapping.palletWeight || 0,
        images: null,
        impacts: {
          materialsImpact: 0,
          manufacturingImpact: 0,
          transportationImpact: 0,
          totalImpact: 0
        }
      };
    }
    
    const product = mapping.productID;
    const materialsImpact = product.co2EmissionRawMaterials || 0;
    const manufacturingImpact = product.co2EmissionFromProcesses || 0;
    const transportationImpact = mapping.totalTransportationEmission || 0;
    
    // Add to running totals
    totalMaterialsImpact += materialsImpact;
    totalManufacturingImpact += manufacturingImpact;
    totalTransportationImpact += transportationImpact;
    
    return {
      productName: product.name,
      productCode: product.code,
      description: product.description || '',
      category: product.category || '',
      subCategory: product.subCategory || '',
      weight: product.weight || 0,
      countryOfOrigin: product.countryOfOrigin || '',
      materials: product.materials || [],
      productManufacturingProcess: product.productManufacturingProcess || [],
      co2EmissionRawMaterials: materialsImpact,
      co2EmissionFromProcesses: manufacturingImpact,
      transportationEmission: transportationImpact,
      transportationLegs: mapping.transportationLegs || [],
      packagingWeight: mapping.packagingWeight || 0,
      palletWeight: mapping.palletWeight || 0,
      images: product.images && product.images.length > 0 ? product.images[0] : null,
      impacts: {
        materialsImpact,
        manufacturingImpact,
        transportationImpact,
        totalImpact: materialsImpact + manufacturingImpact + transportationImpact
      }
    };
  });
  
  // Calculate total project impact
  const totalProjectImpact = parseFloat(
    (totalMaterialsImpact + totalManufacturingImpact + totalTransportationImpact).toFixed(2)
  );
  
  // Format all values to 2 decimal places
  totalMaterialsImpact = parseFloat(totalMaterialsImpact.toFixed(2));
  totalManufacturingImpact = parseFloat(totalManufacturingImpact.toFixed(2));
  totalTransportationImpact = parseFloat(totalTransportationImpact.toFixed(2));
  
  // Update project with impact information
  await Project.findByIdAndUpdate(projectId, {
    totalProjectImpact,
    totalMaterialsImpact,
    totalManufacturingImpact,
    totalTransportationImpact,
    modifiedDate: new Date()
  });
  
  return {
    projectCode: project.code,
    projectName: project.name,
    totalProjectImpact,
    totalMaterialsImpact,
    totalManufacturingImpact,
    totalTransportationImpact,
    products
  };
};

module.exports = {
  getProjectModel,
  getAllProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  deleteAllProjects,
  calculateProjectImpacts
};