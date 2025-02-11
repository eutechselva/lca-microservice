const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const manufacturingProcesses = require("./data/manufacturingProcesses.json");
const billOfMaterials = require("./data/billOfMaterials.json");
const productCategories = require("./data/productCategories.json");
const transportDatabase = require("./data/transport_database.json");
const portDistances = require("./data/port_distances.json");
const { classifyProduct } = require("./utils/chatGPTUtils");

dotenv.config();
const app = express();

// Middleware to parse JSON
app.use(express.json());

app.use(
  cors({
    origin: "*", // Allow both origins
  })
);

const openaiApiKey = process.env.OPENAI_API_KEY;

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

//product route
const productRoutes = require("./routes/productRoutes");
app.use("/api/products", productRoutes);

//project route
const projectRoutes = require('./routes/projectRoutes');
app.use('/api/projects', projectRoutes);

// API Route
app.post("/api/classify-product", async (req, res) => {
  try {
    const { productCode, description, name } = req.body;
    const result = await classifyProduct(productCode, name, description);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Endpoint for classification of manufacturing process
app.post("/api/classify-manufacturing-process", async (req, res) => {
  const { productCode, name, description, bom } = req.body;

  if (!productCode || !name || !description || !bom) {
    return res
      .status(400)
      .json({
        error:
          "Product code, name, description and Bill of Materials are required.",
      });
  }

  try {
    // Format manufacturing processes into a structured string
    const formattedProcesses = Object.entries(manufacturingProcesses)
      .map(
        ([category, processes]) =>
          `- ${category}: ${
            processes.join(", ") || "No specific processes listed"
          }`
      )
      .join("\n");

    // Format the Bill of Materials (BoM) for the prompt
    const formattedBoM = bom
      .map(
        (item) =>
          `- Material Class: ${item.materialClass}, Specific Material: ${item.specificMaterial}, Weight: ${item.weight}kg`
      )
      .join("\n");

    // Build the OpenAI prompt
    const prompt = `
Classify the following product into manufacturing processes strictly based on the materials provided in the Bill of Materials (BoM). Ensure that every material listed in the BoM is included in the response. Each material must have at least one manufacturing process. If no specific process applies, assign a general process like "General Processing."

Product Code: ${productCode}
Product Name: ${name}
Product Description: ${description}

Bill of Materials (BoM):
${formattedBoM}

Categories and Processes:
${formattedProcesses}

Return the result in this format:
[
  {
    "materialClass": "<materialClass>",
    "specificMaterial": "<specificMaterial>",
    "weight": <weight>,
    "manufacturingProcesses": [
      {
        "category": "<category1>",
        "processes": ["<process1>", "..."]
      }
    ]
  },
  ...
]

Rules:
1. Every material in the BoM must be included in the response, and each must have at least one manufacturing process.
2. If no specific processes apply, assign a general process like "General Processing."
3. Use only the categories and processes provided above.
4. Do not include any materialClass or specificMaterial that is not listed in the Bill of Materials (BoM).

Important:
- Do not include any text, explanation, or extra characters outside of the JSON array.
- Ensure the result is strictly valid JSON.

Example Output:
[
  {
    "materialClass": "Metal",
    "specificMaterial": "Steel",
    "weight": 10,
    "manufacturingProcesses": [
      {
        "category": "Metal",
        "processes": ["Cutting", "Welding"]
      }
    ]
  },
  {
    "materialClass": "Fabric",
    "specificMaterial": "Mesh",
    "manufacturingProcesses": [
      {
        "category": "Fabric",
        "processes": ["General Processing"]
      }
    ]
  }
]
`;

    // Send the prompt to OpenAI API
    const openaiApiKey = process.env.OPENAI_API_KEY; // Ensure API key is in environment variables
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Parse the response and return the result
    const chatCompletion = response.data.choices[0]?.message?.content || "[]";
    const result = JSON.parse(chatCompletion);

    res.json(result);
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);

    res.status(500).json({
      error: "An error occurred while processing your request.",
      details: error.response?.data || error.message,
    });
  }
});

// Function to format the BOM data as a string for the prompt
const formatBOMList = (bom) => {
  return Object.entries(bom)
    .map(([category, materials]) => `- ${category}: ${materials.join(", ")}`)
    .join("\n");
};

app.post("/api/classify-bom", async (req, res) => {
  const { productCode, name, description, weight } = req.body;

  if (!productCode || !name || !description || weight === undefined) {
    return res
      .status(400)
      .json({
        error: "Product code, name, description, and weight are required.",
      });
  }

  try {
    // Dynamically generate BOM list for the prompt
    const bomList = formatBOMList(billOfMaterials);

    // Updated prompt for flat list format
    const prompt = `
You are an assistant tasked with classifying products based on their description and distributing a given weight across identified materials.

Product Details:
- Code: ${productCode}
- Name: ${name}
- Description: ${description}
- Total Weight: ${weight} kg

Available Materials:
${bomList}

Your task:
1. Identify relevant materials from the list.
2. Distribute the total weight (${weight} kg) across these materials proportionally based on the description.
3. Ensure that the total weight of all materials adds up exactly to ${weight} kg.
4. Return the result as a flat list in the following JSON format:

[
    {
        "materialClass": "<category>",
        "specificMaterial": "<material>",
        "weight": <weight>
    }
]

Important:
- Do not include any text, explanation, or extra characters outside of the JSON array.
- Ensure the result is strictly valid JSON.
- Ensure the total weight equals ${weight} kg.

Now, classify the product and provide the result.
`;

    // Send the prompt to OpenAI API using gpt-4o
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Extract the content of the response
    const chatCompletion = response.data.choices[0].message.content;

    // Clean the response to remove "```json" or "```" and trim whitespace
    const cleanedResponse = chatCompletion
      .replace(/```json|```/g, "") // Remove code fences
      .trim(); // Remove extra spaces or line breaks

    // Attempt to parse the cleaned response as JSON
    let result;
    try {
      result = JSON.parse(cleanedResponse);
    } catch (error) {
      console.error("Error parsing JSON response:", cleanedResponse);
      return res
        .status(500)
        .json({ error: "Failed to parse JSON from AI response." });
    }

    // Validate the weights in the flat list
    const totalWeightCalculated = result
      .map((material) => material.weight) // Directly access flat list weights
      .reduce((sum, materialWeight) => sum + materialWeight, 0);

    if (Math.abs(totalWeightCalculated - weight) > 0.01) {
      console.warn(
        `Weight mismatch: expected ${weight}, got ${totalWeightCalculated}`
      );
      return res
        .status(400)
        .json({
          error:
            "Total weight of materials does not match the provided weight.",
        });
    }

    res.json(result);
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    res
      .status(500)
      .json({ error: "An error occurred while processing your request." });
  }
});

// Endpoint to return all categories only
app.get("/api/categories", (req, res) => {
  const categories = Object.keys(productCategories); // Extract keys (categories) only
  res.json(categories);
});

// Endpoint to return subcategories based on the given category
app.get("/api/subcategories", (req, res) => {
  const category = req.query.category;

  if (!category) {
    return res
      .status(400)
      .json({ error: "Category is required as a query parameter." });
  }

  const subcategories = productCategories[category];

  if (!subcategories) {
    return res.status(404).json({ error: "Category not found" });
  }

  res.json(subcategories);
});

// Endpoint to return subcategories based on the given category
app.get("/api/productCategories", (req, res) => {
  res.json(productCategories);
});


// Endpoint to return all countries
app.get("/api/countries", (req, res) => {
  const countries = Object.keys(transportDatabase); // Extract all countries
  res.json(countries);
});

app.get("/api/ports", (req, res) => {
  const { country } = req.query;

  if (!country) {
    return res
      .status(400)
      .json({ error: "Country is required as a query parameter." });
  }

  const ports = transportDatabase[country];

  if (!ports) {
    return res.status(404).json({ error: "Country not found or has no ports." });
  }

  res.json(ports);
});

app.get("/api/transportDB", (req, res) => {

  res.json(transportDatabase);
});

// Endpoint to get distance
app.get('/api/distance', (req, res) => {
  const { origin, destination } = req.query;

  if (!origin || !destination) {
    return res.status(400).json({ error: 'Please provide both origin and destination ports.' });
  }

  const originDistances = portDistances[origin];
  
  if (!originDistances) {
    return res.status(404).json({ error: `Origin port '${origin}' not found.` });
  }

  const distance = originDistances[destination];

  if (distance === undefined) {
    return res.status(404).json({ error: `Destination port '${destination}' not found for origin '${origin}'.` });
  }

  res.json({ origin, destination, distance_in_km: distance });
});

app.post('/api/calculate-transport-emission', (req, res) => {
  const EMISSION_FACTORS = {
    SeaFreight: 0.01,
    RoadFreight: 0.16,
    RailFreight: 0.05,
    AirFreight: 0.85
};

  try {
      const { weightKg, transportMode, transportKm } = req.body;

      // Input validation
      if (!weightKg || !transportMode || !transportKm) {
          return res.status(400).json({
              error: 'Missing required parameters'
          });
      }

      if (!EMISSION_FACTORS[transportMode]) {
          return res.status(400).json({
              error: 'Invalid transport mode'
          });
      }

      // Convert weight to tons
      const weightTon = weightKg / 1000;

      // Calculate emission
      const emissionFactor = EMISSION_FACTORS[transportMode];
      const totalEmission = weightTon * transportKm * emissionFactor;

      return res.json({
          transportEmissions: totalEmission.toFixed(2),
          unit: 'kg CO₂eq/unit',
          calculationMetadata: {
              weightTon,
              transportMode,
              transportKm,
              emissionFactor
          }
      });

  } catch (error) {
      return res.status(500).json({
          error: 'Calculation error',
          details: error.message
      });
  }
});

module.exports = {
  classifyProduct,
}