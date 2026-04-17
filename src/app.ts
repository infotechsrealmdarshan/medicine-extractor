import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import searchRoutes from './routes/search.routes';
import logger from './utils/logger';
import path from 'path';

dotenv.config();

const app = express();

// Middlewares
app.use(cors({
  origin: '*', // Allow all origins for the demo. In production, restrict to your Netlify URL.
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Routes
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api', searchRoutes);

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// Fallback to index.html for SPA routing
app.get(/^(?!\/api).*/, (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Middleware Error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

export default app;
