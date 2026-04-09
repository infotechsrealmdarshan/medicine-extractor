"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const search_controller_1 = require("../controllers/search.controller");
const router = (0, express_1.Router)();
router.post('/search', search_controller_1.searchController.search);
router.get('/trident-auth-check', search_controller_1.searchController.tridentAuthCheck);
exports.default = router;
