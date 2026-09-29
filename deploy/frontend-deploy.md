# Deploying the web frontend

```bash
cd ~/app/cmx_dialer/frontend
npm ci            # only when package-lock.json changed
npm run build
sudo cp -a /var/www/dialer-frontend /var/www/dialer-frontend.bak-$(date +%Y%m%d-%H%M)   # optional backup
sudo rsync -a --delete dist/ /var/www/dialer-frontend/
sudo chown -R apache:apache /var/www/dialer-frontend
sudo restorecon -R /var/www/dialer-frontend
```

Roll back: `sudo rsync -a --delete /var/www/dialer-frontend.bak-<date>/ /var/www/dialer-frontend/`
