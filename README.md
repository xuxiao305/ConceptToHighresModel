# Concept To Highres Model — UI Mockup

A fully interactive UI mockup for an AIGC modeling tool that takes concept art through to a fully assembled high-resolution model.

Built with **Vite + React + TypeScript**. Pure UI mockup — no AI backend, 3D viewports are placeholders.

## Pages

1. **Concept to Rough Model** — single 5-node pipeline (Concept → T Pose → Multi-View → Rough Model → Rigging)
2. **Highres Model** — multiple parallel Part pipelines, each with 8 nodes including 3 optional ones (Modify, Re-Texturing, Region Define)
3. **Model Assemble** — 3D viewport with Outliner / Galleries / Landmark Points + Align Tools

## Features

- Deep dark Blender-style theme
- State-driven node cards (idle / ready / running / complete / error / optional)
- Animated SVG connectors between nodes
- Add / delete / rename Part pipelines with confirmation modal
- Optional nodes collapse with dashed border
- Side-by-side 3D comparison toggle on Highres Model node
- Mock landmark-based alignment with simulated least-squares error

## Develop

**一键启动**（Windows）：双击 [run.bat](run.bat) 即可，自动安装依赖、启动 Vite、打开浏览器。

或手动：

```powershell
npm install
npm run dev      # http://localhost:5173/
npm run build    # production bundle
```

## Layout

```
src/
├── App.tsx                  # Page router + global status bar
├── types/index.ts           # NodeState machine, configs
├── components/
│   ├── Button.tsx
│   ├── NodeCard.tsx         # State-driven border, optional collapse
│   ├── NodeConnector.tsx    # SVG arrow with flow animation
│   ├── Placeholder.tsx      # image / multiview / 3d / split3d
│   ├── TopNav.tsx
│   └── StatusBar.tsx
└── pages/
    ├── Page1/ConceptToRoughModel.tsx
    ├── Page2/HighresModel.tsx + PartPipeline.tsx
    └── Page3/ModelAssemble.tsx
```

See [Document/Design/Design_UI.txt](Document/Design/Design_UI.txt) for the full design spec.
