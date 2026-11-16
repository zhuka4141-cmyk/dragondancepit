# FKU RJ · 3D 数字档案

公开站点：https://zhuka4141-cmyk.github.io/fku-rj-viewer/

纯静态 Three.js 0.169.0 查看器，使用正交投影消除透视畸变，保留原有界面。GitHub Pages 发布来源为 `main` + `/(root)`。

- 电脑：左键旋转，滚轮缩放，右键平移。
- 手机：一指旋转，双指缩放和平移。
- 支持前后左右、俯视、仰视、等轴测；自动旋转、线框、网格、轮廓线、复位、PNG 截图和浏览器支持的全屏。
- 快捷键：R 自动旋转，W 线框，G 网格，E 轮廓，0 复位，S 截图，F 全屏。

模型路径固定为 `./model/fku_rj.glb`，使用普通 Git 文件，不使用 Git LFS。模型来自 STEP AP214，转网格参数为 0.1 mm / 0.35 rad。GLB 坐标适配了查看器的 X -90° 旋转；长度仍以米存储，界面换算为毫米。

源 STEP 的 `co2气瓶` 节点只有坐标系，没有可导出的曲面或实体，因此该零件不会显示。

本地预览：

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8000/`。更新同一路径的 GLB 并 push 到 main 后，等待 Pages 部署成功即可。
