# Use the official Playwright image
FROM mcr.microsoft.com/playwright:v1.50.0-focal

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install root dependencies
RUN npm install

# Install backend dependencies
WORKDIR /app/backend
RUN npm install

# Install frontend dependencies
WORKDIR /app/frontend
RUN npm install

# Copy source code
WORKDIR /app
COPY . .

# Build backend and frontend
RUN npm run build:all

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start the application
WORKDIR /app/backend
CMD ["npm", "start"]
