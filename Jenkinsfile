pipeline {
    agent any

    environment {
        IMAGE          = "ghcr.io/prem7443/todos-api"
        DEPLOY_HOST    = "100.48.135.152"
        DEPLOY_USER    = "ubuntu"
        SECRET_ID      = "apps/todos-api/db-url"
        CONTAINER_NAME = "todos-api"
        APP_PORT       = "3001"
        LASTGOOD_FILE  = "/opt/apps/todos-api.lastgood"
        HEALTH_URL     = "http://localhost:3001/health"
        HEALTH_RETRIES = "5"
        HEALTH_DELAY   = "3"
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_SHA = sh(script: "git rev-parse --short HEAD", returnStdout: true).trim()
                    env.IMAGE_TAG = "${IMAGE}:${GIT_SHA}"
                }
                echo "Building ${env.IMAGE_TAG}"
            }
        }

        stage('Test') {
            steps {
                sh '''
                    docker run --rm -v "$WORKSPACE":/app -w /app node:20-slim \
                        sh -c "npm install && npm test"
                '''
            }
        }

        stage('Build Image') {
            steps {
                sh "docker build -t ${IMAGE_TAG} -t ${IMAGE}:latest ."
            }
        }

        stage('Push to GHCR') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'ghcr-creds',
                    usernameVariable: 'GHCR_USER',
                    passwordVariable: 'GHCR_PAT'
                )]) {
                    sh '''
                        echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
                        docker push ${IMAGE_TAG}
                        docker push ${IMAGE}:latest
                    '''
                }
            }
        }

        stage('Run Migrations') {
            steps {
                sshagent(credentials: ['deploy-ssh-key']) {
                    sh '''
                        ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} "
                            set -e
                            DB_URL=\\$(aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --query SecretString --output text)
                            docker pull ${IMAGE_TAG}
                            docker run --rm -e DATABASE_URL=\\"\\$DB_URL\\" ${IMAGE_TAG} npx prisma migrate deploy
                        "
                    '''
                }
            }
        }

        stage('Deploy') {
            steps {
                sshagent(credentials: ['deploy-ssh-key']) {
                    sh '''
                        ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} "
                            set -e
                            DB_URL=\\$(aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --query SecretString --output text)
                            docker stop ${CONTAINER_NAME} || true
                            docker rm ${CONTAINER_NAME} || true
                            docker run -d --name ${CONTAINER_NAME} --restart unless-stopped \\
                                -e DATABASE_URL=\\"\\$DB_URL\\" \\
                                -p ${APP_PORT}:${APP_PORT} \\
                                ${IMAGE_TAG}
                        "
                    '''
                }
            }
        }

        stage('Post-Deploy Health Check') {
            steps {
                sshagent(credentials: ['deploy-ssh-key']) {
                    script {
                        def healthy = false
                        for (int i = 0; i < env.HEALTH_RETRIES.toInteger(); i++) {
                            def status = sh(
                                script: """
                                    ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} \
                                        "curl -s -o /dev/null -w '%{http_code}' ${HEALTH_URL}" || true
                                """,
                                returnStdout: true
                            ).trim()
                            if (status == '200') {
                                healthy = true
                                break
                            }
                            sleep(env.HEALTH_DELAY.toInteger())
                        }
                        if (!healthy) {
                            error("Health check failed after ${env.HEALTH_RETRIES} attempts (non-200 response, or no response) - triggering rollback")
                        }
                    }
                }
            }
        }

        stage('Record Last-Known-Good') {
            steps {
                sshagent(credentials: ['deploy-ssh-key']) {
                    sh '''
                        ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} \
                            "echo ${GIT_SHA} > ${LASTGOOD_FILE}"
                    '''
                }
            }
        }
    }

    post {
        failure {
            echo 'Deploy failed health check - rolling back to last known-good image tag.'
            sshagent(credentials: ['deploy-ssh-key']) {
                sh '''
                    ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} "
                        set -e
                        if [ -f ${LASTGOOD_FILE} ]; then
                            LAST_GOOD=\\$(cat ${LASTGOOD_FILE})
                            DB_URL=\\$(aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --query SecretString --output text)
                            docker stop ${CONTAINER_NAME} || true
                            docker rm ${CONTAINER_NAME} || true
                            docker run -d --name ${CONTAINER_NAME} --restart unless-stopped \\
                                -e DATABASE_URL=\\"\\$DB_URL\\" \\
                                -p ${APP_PORT}:${APP_PORT} \\
                                ${IMAGE}:\\$LAST_GOOD
                        else
                            echo 'No last-known-good tag recorded yet - nothing to roll back to.'
                        fi
                    "
                '''
            }
        }
        success {
            echo "Deploy succeeded and passed health check. Live tag: ${env.GIT_SHA}"
        }
    }
}
