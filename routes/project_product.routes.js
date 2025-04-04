const express = require('express');
const router = express.Router();
const projectProductController = require('../controllers/project_product.controller');
const { validateAccount } = require('../middlewares/auth.middleware');

// Apply account validation middleware
router.use(validateAccount);

// Base routes
router.route('/')
  .post(projectProductController.createProjectProductMapping)
  .get(projectProductController.getAllProjectProductMappings);

// Routes with ID
router.route('/:id')
  .get(projectProductController.getProjectProductMappingById)
  .put(projectProductController.updateProjectProductMapping)
  .delete(projectProductController.deleteProjectProductMapping);

// Project-specific routes
router.route('/project/:projectID')
  .get(projectProductController.getProjectProductMappingsByProjectId)
  .delete(projectProductController.deleteProjectProductMappingsByProjectId);

// Product-specific routes
router.route('/product/:productID')
  .get(projectProductController.getProjectProductMappingsByProductId);

module.exports = router;