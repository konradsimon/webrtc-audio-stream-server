FROM node:18-slim

# Install dependencies for mediasoup
RUN apt-get update && \
    apt-get install -y \
    python3 \
    make \
    g++ \
    && apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose ports
EXPOSE 3000 1935 40000-49999/udp 40000-49999/tcp

# Start the server
CMD ["node", "server.js"]


