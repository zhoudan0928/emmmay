FROM node:18-slim

# 创建非root用户
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --gid 1001 nodejs

WORKDIR /app

# 复制package文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY . .

# 设置正确的权限
RUN chown -R nodejs:nodejs /app

# 切换到非root用户
USER nodejs

# 暴露端口（注意：这只是文档说明，实际端口由Koyeb的PORT环境变量决定）
EXPOSE 8080

# 启动应用
CMD ["node", "app.js"] 