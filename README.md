# 🚀 Codeline Developer Tracking Hub

A real-time leaderboards and tracking dashboard designed for the Codeline trainee program. This system tracks GitHub contributions, calculates internal team rankings, ranks developers nationally against the Top 256 developers in Oman (via `committers.top`), and provides interactive visualizations of team contributions.

## ✨ Features
*   **Internal & National Rankings:** View developer standings within the organization or nationally in Oman.
*   **Contribution Scopes:** Toggle between Public-only commits and All (Public + Private) commits.
*   **Batch / Team Leaderboards:** Aggregates commits by Organization and Tech Stack, featuring interactive contribution breakdown charts.
*   **Automated Data Gathering:** Uses the GitHub GraphQL API for internal stats and Cheerio for robust HTML scraping of `committers.top`.
*   **Caching Layer:** Redis integration ensures blazing-fast load times and respects rate limits.
*   **Historical Tracking:** Saves daily rankings to a MySQL database to calculate "Rank Improved/Dropped" metrics.

---

## 📋 Prerequisites

To run this project, you will need the following installed on your server or local machine:
*   **Node.js** (v16+ recommended)
*   **MySQL** (v8.0+)
*   **Redis** (v5+)
*   **Nginx** (For production deployment)
*   **PM2** (For process management)

---

## ⚙️ Configuration & Setup

### 1. The `accounts.txt` File
This file acts as the primary data source for who is being tracked. 
**Format strictly requires 3 comma-separated values per line:**
`[GitHub Profile URL], [Organization Name], [Tech Stack]`

*Example `accounts.txt`:*
```text
https://github.com/Reemkhalifa2, TRA, Java Full Stack 
https://github.com/ShahadHamed, TRA, C# Full Stack
https://github.com/SulaimanAlfarsi, OPAL, Java Full Stack
```

### 2. Environment Variables (`secrets.env`)
Create a file named `secrets.env` in the root directory. The application uses this to securely connect to external services.

```env
# Database Credentials
DB_HOST=127.0.0.1
DB_USER=your_mysql_user
DB_PASSWORD=your_mysql_password

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

## 🛠️ Server Environment Setup (Ubuntu/Debian)

### 1. Install Node.js & Dependencies
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone the repository and navigate to it
# git clone <your-repo-url> /var/www/dashboard
cd /var/www/dashboard

# Install NPM dependencies
npm install
```

### 2. Setup MySQL
```bash
# Install MySQL
sudo apt update
sudo apt install mysql-server

# Secure installation (optional but recommended)
sudo mysql_secure_installation

# Log into MySQL root
sudo mysql
```
Run the following SQL commands to create a user for the application:
```sql
CREATE USER 'codeline_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON *.* TO 'codeline_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```
*(Note: The Node.js application will automatically create the `github_tracker` database and `user_ranks` table upon its first run).*

### 3. Setup Redis
```bash
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

---

## 🚀 Production Deployment

### 1. PM2 Setup
PM2 is used to keep the Node.js application running in the background and restart it if it crashes.

```bash
# Install PM2 globally
sudo npm install -g pm2

# Navigate to project directory
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

# Create logs directory
mkdir logs

# Start the application
pm2 start ecosystem.config.js

# Ensure PM2 starts on system boot
pm2 startup
pm2 save
```

### 2. Nginx Reverse Proxy Setup
Nginx is used to expose the Node application securely to the web on port 80/443.

```bash
# Install Nginx
sudo apt install nginx

# Create a new Nginx site configuration
sudo nano /etc/nginx/sites-available/codeline
```

Paste the following configuration (replace `your_domain.com` with your actual domain or IP address):
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

Enable the configuration and restart Nginx:
```bash
# Link the config to enabled sites
sudo ln -s /etc/nginx/sites-available/codeline /etc/nginx/sites-enabled/

# Test Nginx configuration for syntax errors
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

---

## 🧰 PM2 Commands Cheat Sheet

For managing your deployed application, use the following PM2 commands from `/var/www/dashboard`:

| Task | Command |
| :--- | :--- |
| **Start Server** | `pm2 start ecosystem.config.js` |
| **View Status** | `pm2 list` |
| **View Live Logs** | `pm2 logs codeline-api` |
| **View Last 100 Logs** | `pm2 logs codeline-api --lines 100` |
| **Restart Server** | `pm2 restart codeline-api` |
| **Zero-Downtime Reload**| `pm2 reload codeline-api` |
| **Stop Server** | `pm2 stop codeline-api` |
| **Monitor CPU/RAM** | `pm2 monit` |
| **Flush/Clear Logs** | `pm2 flush` |
| **Save state for Reboot**| `pm2 save` |

### Troubleshooting Port Conflicts
If port `3000` is already in use:
```bash
# Find what is using the port
sudo lsof -i :3000
# Kill the process (replace <PID> with the Process ID)
sudo kill -9 <PID>
```

---

## 🧹 Cache Management
Because the app relies heavily on Redis for performance, you may occasionally need to invalidate the cache manually (e.g., when adding a new user to `accounts.txt`).

Send a POST request to your server using the token defined in `secrets.env`:
```bash
curl -X POST "http://your_domain.com/api/invalidate-cache?token=super_secret_token_123"
```
