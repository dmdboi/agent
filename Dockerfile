# ---- Builder Stage ----
FROM node:24-alpine AS builder
WORKDIR /app

# Copy package files first for better caching
COPY package*.json tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# ---- Production Stage ----
FROM node:24-alpine
WORKDIR /app

# Stamped by CI from package.json version (see docker-publish.yml) so a
# running container can report its own version in heartbeats.
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=${AGENT_VERSION}

# Install runtime dependencies (Alpine uses apk)
RUN apk add --no-cache \
    ca-certificates \
    curl \
    git \
    iproute2 \
    tini

# Copy package files and install ONLY production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built code from builder
COPY --from=builder /app/dist ./dist

# Use tini as entrypoint for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Default command
CMD ["node", "dist/app.js"]