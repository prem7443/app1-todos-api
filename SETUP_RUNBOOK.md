# Tonight's Runbook — copy/paste in order

## 0. Prereqs
- AWS account, AWS CLI configured (`aws configure`)
- A key pair for SSH (`aws ec2 create-key-pair --key-name deploy-key --query 'KeyMaterial' --output text > deploy-key.pem && chmod 400 deploy-key.pem`)
- Your current public IP: `curl ifconfig.me`

---

## 1. Launch EC2 (single server for both apps)

```bash
# Security group: SSH restricted to YOUR IP only, HTTP/HTTPS open to world
aws ec2 create-security-group --group-name apps-sg --description "apps server sg"

MY_IP=$(curl -s ifconfig.me)/32

aws ec2 authorize-security-group-ingress --group-name apps-sg --protocol tcp --port 22 --cidr $MY_IP
aws ec2 authorize-security-group-ingress --group-name apps-sg --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-name apps-sg --protocol tcp --port 443 --cidr 0.0.0.0/0
# Jenkins UI on 8090 - restrict this to your IP too, reviewer will get a viewer login, doesn't need port open to world if you tunnel,
# but simplest for reviewer access is to allow it from anywhere with a locked-down viewer account:
aws ec2 authorize-security-group-ingress --group-name apps-sg --protocol tcp --port 8090 --cidr 0.0.0.0/0

aws ec2 run-instances \
  --image-id ami-0c101f26f147fa7fd \
  --count 1 \
  --instance-type t3.small \
  --key-name deploy-key \
  --security-groups apps-sg \
  --query 'Instances[0].InstanceId' --output text
```
(t3.small, not micro — you're running Jenkins + 2 node apps + PM2, micro will swap/thrash under Jenkins builds.)

Get the public IP:
```bash
aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text
```

---

## 2. Launch RDS (one instance, two databases)

```bash
aws ec2 create-security-group --group-name rds-sg --description "rds sg"
# Only allow Postgres from the app server's SG, not the internet
APPS_SG_ID=$(aws ec2 describe-security-groups --group-names apps-sg --query 'SecurityGroups[0].GroupId' --output text)

aws ec2 authorize-security-group-ingress --group-name rds-sg --protocol tcp --port 5432 --source-group $APPS_SG_ID

aws rds create-db-instance \
  --db-instance-identifier apps-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --master-username postgres \
  --master-user-password 'CHANGE_ME_STRONG_PW' \
  --allocated-storage 20 \
  --vpc-security-group-ids $(aws ec2 describe-security-groups --group-names rds-sg --query 'SecurityGroups[0].GroupId' --output text) \
  --no-publicly-accessible \
  --backup-retention-period 1
```

Once available, get the endpoint:
```bash
aws rds describe-db-instances --db-instance-identifier apps-db --query 'DBInstances[0].Endpoint.Address' --output text
```

SSH in and create two databases + two users:
```sql
-- psql -h <rds-endpoint> -U postgres
CREATE DATABASE app1_db;
CREATE DATABASE multiauth_db;
CREATE USER app1_user WITH PASSWORD 'pw1';
CREATE USER multiauth_user WITH PASSWORD 'pw2';
GRANT ALL PRIVILEGES ON DATABASE app1_db TO app1_user;
GRANT ALL PRIVILEGES ON DATABASE multiauth_db TO multiauth_user;
```

---

## 3. Server base setup (SSH in)

```bash
ssh -i deploy-key.pem ubuntu@<EC2_PUBLIC_IP>

sudo apt update && sudo apt install -y nginx git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

sudo mkdir -p /opt/apps
sudo chown -R ubuntu:ubuntu /opt/apps
```

---

## 4. Deploy App 1

```bash
cd /opt/apps
git clone <YOUR_APP1_REPO_URL> todos-api
cd todos-api
npm ci
cp .env.example .env
nano .env   # fill DATABASE_URL with app1_user creds
npx prisma migrate deploy
pm2 start src/index.js --name todos-api
pm2 save
curl localhost:3001/health
```

---

## 5. Deploy App 2 (Multi-Auth)

```bash
cd /opt/apps
git clone https://github.com/rohan-serviots/Multi-Auth.git multi-auth
cd multi-auth
# set .env per repo's requirements (DATABASE_URL -> multiauth_user creds, PORT=3002, JWT secrets etc.)
npm install
npx prisma migrate deploy
npm run build
pm2 start npm --name multi-auth -- run start
pm2 save
curl localhost:3002/health   # confirm the app exposes a health route; if not, note in README
```

---

## 6. Nginx

```bash
sudo cp nginx/sites-available.conf /etc/nginx/sites-available/apps.conf
# edit server_name lines to app1.<EC2_IP>.sslip.io / app2.<EC2_IP>.sslip.io
sudo ln -s /etc/nginx/sites-available/apps.conf /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```
Test: `curl http://app1.<EC2_IP>.sslip.io/health` and `curl http://app2.<EC2_IP>.sslip.io`

---

## 7. Jenkins

```bash
sudo apt install -y openjdk-17-jre
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key | sudo tee /usr/share/keyrings/jenkins-keyring.asc > /dev/null
echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" | sudo tee /etc/apt/sources.list.d/jenkins.list
sudo apt update && sudo apt install -y jenkins

sudo sed -i 's/HTTP_PORT=8080/HTTP_PORT=8090/' /etc/default/jenkins
sudo systemctl restart jenkins
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```
Visit `http://<EC2_IP>:8090`, finish setup wizard, install suggested plugins + "SSH Agent" plugin.

Create two Pipeline jobs pointing at your two GitHub repos (Jenkinsfile in SCM). Add a webhook in each GitHub repo (or use Poll SCM `* * * * *` if you can't expose a webhook receiver quickly) to trigger on push.

Create a second Jenkins user with **Overall/Read + Job/Read** only (Manage Jenkins → Users, and Configure Global Security → Matrix Authorization) — this is the reviewer's viewer account.

---

## 8. IAM read-only user for reviewer

```bash
aws iam create-user --user-name reviewer-readonly

cat > readonly-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroups",
        "rds:DescribeDBInstances",
        "logs:DescribeLogGroups",
        "logs:GetLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-user-policy --user-name reviewer-readonly --policy-name scoped-readonly --policy-document file://readonly-policy.json
aws iam create-access-key --user-name reviewer-readonly
```
Save the AccessKeyId/SecretAccessKey — **send only in the submission email, never commit.**

---

## 9. Commit properly (not one commit!)

```bash
git init
git add package.json .gitignore
git commit -m "Init: project scaffold and dependencies"
git add prisma/
git commit -m "Add Prisma schema for Todo model"
git add src/index.js .env.example
git commit -m "Implement CRUD routes and /health endpoint"
git add src/test/
git commit -m "Add smoke tests for CI"
git add Jenkinsfile
git commit -m "Add Jenkins pipeline: build/test/deploy/health-check/rollback"
git add nginx/
git commit -m "Add Nginx reverse proxy config"
git add README.md SETUP_RUNBOOK.md
git commit -m "Add README with architecture and reasoning answers"
git remote add origin <YOUR_REPO_URL>
git push -u origin main
```
