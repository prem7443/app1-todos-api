// Jenkinsfile - App 1 (Todos CRUD API)
// Pipeline: build -> test -> deploy -> health check -> rollback on failure
//
// Rollback strategy: before deploying the new version, we tag the currently
// running commit as "last-known-good" via a marker file on the server.
// If the post-deploy health check fails, we git reset to that commit,
// reinstall, and restart PM2 - no manual SSH required.

pipeline {
    agent any

    environment {
        APP_DIR        = '/opt/apps/todos-api'
        PM2_NAME       = 'todos-api'
        HEALTH_URL     = 'http://localhost:3001/health'
        HEALTH_RETRIES = '5'
        HEALTH_DELAY   = '3'   // seconds between retries
    }

    stages {
        stage('Build') {
            steps {
                sh '''
                    npm ci
                    npx prisma generate
                '''
            }
        }

        stage('Test') {
            steps {
                sh 'npm test'
            }
        }

        stage('Record Last-Known-Good') {
            steps {
                // Capture current deployed commit on the server before we overwrite it,
                // so rollback has something concrete to return to.
                sh '''
                    ssh -o StrictHostKeyChecking=no deploy@$DEPLOY_HOST \
                        "cd $APP_DIR && git rev-parse HEAD > /opt/apps/todos-api-last-good.txt || true"
                '''
            }
        }

        stage('Deploy') {
            steps {
                sh '''
                    ssh -o StrictHostKeyChecking=no deploy@$DEPLOY_HOST "
                        set -e
                        cd $APP_DIR
                        git fetch origin main
                        git reset --hard origin/main
                        npm ci --omit=dev
                        npx prisma migrate deploy
                        pm2 reload $PM2_NAME --update-env || pm2 start src/index.js --name $PM2_NAME
                    "
                '''
            }
        }

        stage('Post-Deploy Health Check') {
            steps {
                script {
                    def healthy = false
                    for (int i = 0; i < env.HEALTH_RETRIES.toInteger(); i++) {
                        def status = sh(
                            script: "curl -s -o /dev/null -w '%{http_code}' $HEALTH_URL || true",
                            returnStdout: true
                        ).trim()
                        if (status == '200') {
                            healthy = true
                            break
                        }
                        sleep(env.HEALTH_DELAY.toInteger())
                    }
                    if (!healthy) {
                        error("Health check failed after ${env.HEALTH_RETRIES} attempts - triggering rollback")
                    }
                }
            }
        }
    }

    post {
        failure {
            echo 'Deploy failed health check - rolling back to last known-good commit.'
            sh '''
                ssh -o StrictHostKeyChecking=no deploy@$DEPLOY_HOST "
                    set -e
                    cd $APP_DIR
                    LAST_GOOD=\\$(cat /opt/apps/todos-api-last-good.txt)
                    git reset --hard \\$LAST_GOOD
                    npm ci --omit=dev
                    pm2 reload $PM2_NAME --update-env
                "
            '''
        }
        success {
            echo 'Deploy succeeded and passed health check.'
        }
    }
}
