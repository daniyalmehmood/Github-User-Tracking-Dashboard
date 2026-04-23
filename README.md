# 🚀 Codeline Developer Tracking Hub

A real-time leaderboards and tracking dashboard designed for the Codeline trainee program. This system tracks GitHub contributions, calculates internal team rankings, ranks developers nationally against the Top 256 developers in Oman (via `committers.top`), and provides interactive 3D visualizations of team contributions.

## ✨ Features
*   **Internal & National Rankings:** View developer standings within your organization or nationally in Oman.
*   **Contribution Scopes:** Toggle between Public-only commits and All (Public + Private) commits.
*   **Batch / Team Leaderboards:** Aggregates commits by Organization and Tech Stack, featuring interactive 3D donut charts.
*   **Automated Data Gathering:** Uses the GitHub GraphQL API for internal stats and Cheerio for robust HTML scraping of `committers.top`.
*   **Caching Layer:** Redis integration ensures blazing-fast load times and prevents API rate-limiting.
*   **Historical Tracking:** Saves daily rankings to a MySQL database to calculate "Rank Improved/Dropped" metrics.

---

## 📋 Prerequisites

Depending on your deployment method, ensure you have the following installed:

**For Docker Deployment (Recommended):**
*   Docker
*   Docker Compose

**For Bare-Metal Deployment:**
*   Node.js (v18+ recommended)
*   MySQL (v8.0+)
*   Redis (v5+)
*   Nginx & PM2

---

## ⚙️ Configuration & Setup

Before starting the server using either method, you must configure your data and secrets.

### 1. The `accounts.txt` File
This file is the primary data source for who is being tracked. It must be placed in the root directory.
**Format strictly requires 3 comma-separated values per line:**
`[GitHub Profile URL], [Organization Name], [Tech Stack]`

*Example `accounts.txt`:*
```text
https://github.com/Reemkhalifa2, TRA, Java Full Stack 
https://github.com/ShahadHamed, TRA, C# Full Stack
https://github.com/SulaimanAlfarsi, OPAL, Java Full Stack
```

### 2. Environment Variables (`secrets.env`)
Create a file named `secrets.env` in the root directory.

```env
# Database Credentials
DB_HOST=127.0.0.1
DB_USER=codeline_user
DB_PASSWORD=StrongPassword123!

# Redis Configuration
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# GitHub Authentication
# Generate a Personal Access Token (PAT) from GitHub with 'read:user' permissions
GITHUB_TOKEN=ghp_your_github_token_here

# Cache Invalidation Token
# Used to manually clear Redis cache via /api/invalidate-cache?token=...
CACHE_INVALIDATE_TOKEN=super_secret_token_123
```

---

## 🐳 Deployment Method 1: Docker (Recommended)

Using Docker is the easiest way to deploy the application because it automatically sets up Node.js, MySQL, and Redis inside isolated containers.

### 1. Start the Containers
Run the following command in the root directory (where your `docker-compose.yml` is located):
```bash
docker-compose up -d --build
```
*The app will be available at `http://localhost:3000`.*

### 2. Updating Developer Accounts
The `accounts.txt` file is mounted as a volume. If you edit `accounts.txt` on your host machine, the changes will reflect immediately without needing to restart the Docker container!

### 3. Useful Docker Commands
```bash
# View live application logs
docker-compose logs -f app

# Stop the server (keeps data intact)
docker-compose stop

# Tear down the server and networks
docker-compose down

# Tear down AND wipe database/cache data
docker-compose down -v
```

---

## 🛠️ Deployment Method 2: Bare-Metal (Ubuntu/Debian)

If you prefer installing services directly onto your Linux server without Docker, follow these steps:

### 1. Install Node.js & Dependencies
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Navigate to project directory
cd /var/www/dashboard

# Install NPM dependencies
npm install
```

### 2. Setup MySQL
```bash
sudo apt update
sudo apt install mysql-server
sudo mysql_secure_installation
sudo mysql
```
Inside the MySQL prompt, create the user defined in your `secrets.env`:
```sql
CREATE USER 'codeline_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON *.* TO 'codeline_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```
*(The Node.js application automatically creates the database and tables on its first run).*

### 3. Setup Redis
```bash
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### 4. Configure PM2 (Process Manager)
PM2 keeps the Node.js application running in the background and restarts it on crashes/reboots.

```bash
sudo npm install -g pm2
cd /var/www/dashboard

# Create Ecosystem config file
cat <<EOT > ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "codeline-api",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production"
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time_format: "YYYY-MM-DD HH:mm:ss Z",
      max_memory_restart: "500M",
      watch: false,
      ignore_watch: ["node_modules", "logs"]
    }
  ]
};
EOT

mkdir logs
pm2 start ecosystem.config.js

# Ensure PM2 starts on system boot
pm2 startup
pm2 save
```

### 5. Configure Nginx Reverse Proxy
Nginx routes port 80 (HTTP) traffic to your Node.js app running on port 3000.

```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/codeline
```
Paste the following (replace `your_domain.com` with your IP or domain):
```nginx
server {
    listen 80;
    server_name your_domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```
Enable and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/codeline /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 🧰 PM2 Commands Cheat Sheet

| Task | Command |
| :--- | :--- |
| **View Status** | `pm2 list` |
| **View Live Logs** | `pm2 logs codeline-api` |
| **Restart Server** | `pm2 restart codeline-api` |
| **Monitor CPU/RAM** | `pm2 monit` |
| **Clear Logs** | `pm2 flush` |

---

## 🧹 Cache Management

To ensure blazing-fast load times, this app heavily caches data in Redis. If you add new users to `accounts.txt` or need to forcefully fetch fresh stats from GitHub, you can invalidate the cache via a secure HTTP request.

Send a POST request using the `CACHE_INVALIDATE_TOKEN` defined in your `secrets.env`:

**Using cURL:**
```bash
curl -X POST "http://localhost:3000/api/invalidate-cache?token=super_secret_token_123"
```
*(If you've set up Nginx, replace `localhost:3000` with your actual domain).*
