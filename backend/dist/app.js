"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const search_routes_1 = __importDefault(require("./routes/search.routes"));
const logger_1 = __importDefault(require("./utils/logger"));
dotenv_1.default.config();
const app = (0, express_1.default)();
// Middlewares
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Routes
app.use('/api', search_routes_1.default);
// Root route
app.get('/', (req, res) => {
    res.json({ message: 'Supplier Scraper API is running' });
});
// Error handling middleware
app.use((err, req, res, next) => {
    logger_1.default.error(`Middleware Error: ${err.message}`);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
    });
});
exports.default = app;
