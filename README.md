# Toni AI — Developed by Zain Shoaib

Full-stack multilingual AI assistant (Roman Urdu, Urdu script, English & global languages) with DeepSeek-inspired Black & White workspace, Quick Streaming, DeepThink reasoning, Interactive Voice Mode (Crystal-Clear Male Voice), Microphone Voice Chat, Automatic Backend Image Generation & Editing, Persistent Memory Bank, and Secure Authentication.

---

## Complete Project Structure

Make sure **all** of the following files and the `src/` folder are uploaded to your GitHub repository (if you use GitHub's web uploader, drag the entire `src` folder so `/src/main.tsx` is preserved):

```text
├── .env.example
├── .gitignore
├── index.html
├── main.tsx
├── metadata.json
├── package.json
├── render.yaml
├── server.ts
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── App.tsx
    ├── index.css
    ├── main.tsx
    ├── types.ts
    ├── components/
    │   ├── InteractiveLogo.tsx
    │   ├── MarkdownRenderer.tsx
    │   └── Modals.tsx
    └── utils/
        └── storage.ts
```

---

## Deploying to Render

1. **Push or Upload to GitHub**:
   Ensure the `src/` directory (including `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/types.ts`, `src/components/`, and `src/utils/`) is present in your repository.
2. **Create a Web Service on Render**:
   - **Runtime**: `Node`
   - **Build Command**: `yarn install && yarn build` (or `npm install && npm run build`)
   - **Start Command**: `yarn start` (or `npm start`)
3. **Environment Variables on Render**:
   Add the following in your Render Service **Environment** tab:
   - `GEMINI_API_KEY`: Your Google Gemini API key (kept strictly server-side in `server.ts`, never exposed in frontend code)
   - `NODE_VERSION`: `22.14.0`
   - `NODE_ENV`: `production`
