const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");

const { getModel, getAccount } = require("./utils/utils");
const productSchema = require("./models/product_schema");
const projectProductMapSchema = require('./models/project_product_map_schema');
const projectSchema = require("./models/project_schema");

const productCategories = require("./data/productCategories.json");
const transportDatabase = require("./data/transport_database.json");
const portDistances = require("./data/port_distances.json");
const {
  classifyProduct,
  classifyBOM,
  classifyManufacturingProcess,
} = require("./utils/chatGPTUtils");

const { HTTP_STATUS } = require("./utils/utils");

dotenv.config();
const app = express();

// Middleware to parse JSON
app.use(express.json());

app.use(
  cors({
    origin: "*", // Allow both origins
  })
);

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

//product route
const productRoutes = require("./routes/productRoutes");
app.use("/api/products", productRoutes);

//project route
const projectRoutes = require("./routes/projectRoutes");
app.use("/api/projects", projectRoutes);

//product-project mapping route
const projectProductRoutes = require("./routes/project_product_routes");
app.use("/api/project-product-mapping", projectProductRoutes);

// API Route
app.post("/api/classify-product", async (req, res) => {
  try {
    const { productCode, description, name } = req.body;
    const result = await classifyProduct(productCode, name, description);
    res.status(HTTP_STATUS.OK).json({ success: true, data: result });
  } catch (error) {
    console.log(error);
    res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ success: false, error: error.message });
  }
});

// Endpoint for classification of manufacturing process
app.post("/api/classify-manufacturing-process", async (req, res) => {
  try {
    const { productCode, name, description, bom } = req.body;

    if (!productCode || !name || !description || !bom) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error:
          "Product code, name, description, and Bill of Materials are required.",
      });
    }

    const result = await classifyManufacturingProcess(
      productCode,
      name,
      description,
      bom
    );
    res.status(HTTP_STATUS.OK).json({ success: true, data: result });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while processing your request.",
      details: error.message,
    });
  }
});

app.post("/api/classify-bom", async (req, res) => {
  try {
    const { productCode, name, description, weight, imageUrl } = req.body;

    if (!productCode || !name || !description || weight === undefined) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Product code, name, description, and weight are required.",
      });
    }

    const result = await classifyBOM(
      productCode,
      name,
      description,
      weight,
      imageUrl
    );

    const totalWeightCalculated = result.reduce(
      (sum, material) => sum + material.weight,
      0
    );

    if (Math.abs(totalWeightCalculated - weight) > 0.01) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Total weight of materials does not match the provided weight.",
      });
    }

    res.status(HTTP_STATUS.OK).json({ success: true, data: result });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while processing your request.",
      details: error.message,
    });
  }
});

// Endpoint to return all categories only
app.get("/api/categories", (req, res) => {
  try {
    const categories = Object.keys(productCategories); // Extract keys (categories) only
    res.status(HTTP_STATUS.OK).json({ success: true, data: categories });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving categories.",
    });
  }
});

// Endpoint to return subcategories based on the given category
app.get("/api/subcategories", (req, res) => {
  try {
    const category = req.query.category;

    if (!category) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Category is required as a query parameter.",
      });
    }

    const subcategories = productCategories[category];

    if (!subcategories) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: "Category not found",
      });
    }

    res.status(HTTP_STATUS.OK).json({ success: true, data: subcategories });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving subcategories.",
    });
  }
});

// Endpoint to return all product categories
app.get("/api/productCategories", (req, res) => {
  try {
    res.status(HTTP_STATUS.OK).json({ success: true, data: productCategories });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving product categories.",
    });
  }
});

// Endpoint to return all countries
app.get("/api/countries", (req, res) => {
  try {
    const countries = Object.keys(transportDatabase); // Extract all countries
    res.status(HTTP_STATUS.OK).json({ success: true, data: countries });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving countries.",
    });
  }
});

app.get("/api/ports", (req, res) => {
  try {
    const { country } = req.query;

    if (!country) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Country is required as a query parameter.",
      });
    }

    const ports = transportDatabase[country];

    if (!ports) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: "Country not found or has no ports.",
      });
    }

    res.status(HTTP_STATUS.OK).json({ success: true, data: ports });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving ports.",
    });
  }
});

app.get("/api/transportDB", (req, res) => {
  try {
    res.status(HTTP_STATUS.OK).json({ success: true, data: transportDatabase });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving transport database.",
    });
  }
});

// Endpoint to get distance
app.post("/api/distance", (req, res) => {
  try {
    const { origin, destination } = req.body;

    if (!origin || !destination) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Please provide both origin and destination ports.",
      });
    }

    const originDistances = portDistances[origin];

    if (!originDistances) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: `Origin port '${origin}' not found.`,
      });
    }

    const distance = originDistances[destination];

    if (distance === undefined) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: `Destination port '${destination}' not found for origin '${origin}'.`,
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: { origin, destination, distance_in_km: distance },
    });
  } catch (error) {
    console.log(error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "An error occurred while retrieving distance.",
    });
  }
});

app.post("/api/calculate-transport-emission", (req, res) => {
  const EMISSION_FACTORS = {
    SeaFreight: 0.01,
    RoadFreight: 0.16,
    RailFreight: 0.05,
    AirFreight: 0.85,
  };

  try {
    const { weightKg, transportMode, transportKm } = req.body;

    // Input validation
    if (!weightKg || !transportMode || !transportKm) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Missing required parameters",
      });
    }

    if (!EMISSION_FACTORS[transportMode]) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: "Invalid transport mode",
      });
    }

    // Convert weight to tons
    const weightTon = weightKg / 1000;

    // Calculate emission
    const emissionFactor = EMISSION_FACTORS[transportMode];
    const totalEmission = weightTon * transportKm * emissionFactor;

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        transportEmissions: totalEmission.toFixed(2),
        unit: "kg CO₂eq/unit",
        calculationMetadata: {
          weightTon,
          transportMode,
          transportKm,
          emissionFactor,
        },
      },
    });
  } catch (error) {
    console.log(error);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: "Calculation error",
      details: error.message,
    });
  }
});

app.get("/api/home", async (req, res) => {
  try {
    const Product = await getProductModel(req);
    const Project = await getProjectModel(req);
    const ProjectProductMap = await getProjectProductMapModel(req);

    // Fetch dynamic values from the database
    const totalProducts = await Product.countDocuments();
    const totalImpact = await ProjectProductMap.countDocuments();
    const totalProjects = await Project.countDocuments();;
    const totalCredits = Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;

    return res.status(200).json({
      success: true,
      data: {
        totalProducts,
        totalImpact: totalImpact,
        totalProjects,
        totalCredits: totalCredits,
      },
    });
  } catch (error) {
    console.error("Error fetching data:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

const getProductModel = async (req) => {
  const account = getAccount(req);
  return getModel(account, productSchema, "Product");
};

const getProjectModel = async (req) => {
  const account = getAccount(req);
  return getModel(account, projectSchema, "Project");
};

const getProjectProductMapModel = async (req) => {
  const account = getAccount(req);
  return getModel(account, projectProductMapSchema, "ProjectProductMap");
};

module.exports = {
  classifyProduct,
};
