# Light Sim — WebGL 3D 空间编辑器

基于 Vite + Three.js + Node.js (WebSocket) 构建的高性能 3D 沙盒编辑器。

## 🚀 核心特性
- **渲染引擎**：Three.js + WebGL，支持 PBR 材质、环境光遮蔽 (SSAO)、HDR 天空。
- **光影系统**：后端通过 WebSocket 推送低频全局光 (SH 球谐函数)，前端处理高频局部光与阴影。
- **模型交互**：支持多模型加载、拖放、极速克隆（SkeletonUtils）、自动居中和包围盒计算。
- **移动端适配**：横向工具栏、虚拟摇杆、长按升降按钮。
- **自动化工具**：集成 `@rtcn/tred` (AST 重构引擎) 与 Vite 插件。

## 🛠️ 快速启动
```bash
npm install
npm run dev
```

客户端运行在 http://localhost:5173，WebSocket 服务运行在 ws://localhost:4443。

 `EOF'
  echo "✅ 已生成 README.md (包含 Agent Task 说明)"

3. Git 初始化与提交

if [ ! -d ".git" ]; then
git init
git branch -M main
fi

git add .
git commit -m "feat: complete 3D sandbox with SH lighting, HDR, SSAO, and tred integration" || echo "⚠️ 没有新的改动需要提交"

4. 调用 gh CLI 创建远程仓库并推送

REPO_NAME="light-sim-3d"
echo ">>> 正在创建远程仓库: $REPO_NAME (public)..."
gh repo create "$REPO_NAME" --public --source=. --remote=origin --push

echo ""
echo "============================================================"
echo "  🎉 上传成功！"
echo "============================================================"
echo ""
echo "仓库地址："
gh repo view --web 2>/dev/null || gh repo view
echo ""
echo "接下来，你可以把仓库的 URL 直接发给你的 AI Agent 了！"
echo "README.md 里已经为你写好了 Roadmap 和开发提示，"
echo "Agent 会非常清楚接下来该写哪些代码（比如空间拼接和探针混合）。"
echo "============================================================"
