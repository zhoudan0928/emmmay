FROM node:18-slim

WORKDIR /app

# 复制package文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 8080

# 启动应用
CMD ["node", "app.js"] 