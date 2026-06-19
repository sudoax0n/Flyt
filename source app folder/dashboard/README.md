# ⚛️ Flyt Web Dashboard & Server (DrosUI)

This directory houses the user interface and orchestration backend for **Flyt** (formerly DrosUI). It comprises a React/Vite development server and an Express server that interfaces with the Python computer vision tracking backend.

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have the following installed on your machine:
*   [Node.js](https://nodejs.org/) (v16.0 or higher recommended)
*   [Python 3.8+](https://www.python.org/) (with `venv` support)

### 2. Dependency Setup

Before running the application, make sure dependencies are installed for both the dashboard and the tracker.

#### A. Install Dashboard Dependencies:
Navigate to this directory (`source app folder/dashboard/`) and run:
```bash
npm install
```

#### B. Setup Python Virtual Environment:
Make sure your Python dependencies are installed. Navigate to the tracker folder (`source app folder/tracker/`) and run:
```bash
python -m venv venv
venv\Scripts\activate      # On Windows
pip install -r requirements.txt
```

---

## 🛠️ Run Commands

Run these commands from the `dashboard` directory:

| Command | Action |
| :--- | :--- |
| **`npm run dev`** | Runs both the **Express API Server** and the **Vite React Frontend** concurrently. *(Recommended)* |
| `npm run dev:frontend` | Runs the Vite React dev server only (client-side mockups). |
| `npm run dev:server` | Runs the Express API server only. |
| `npm run build` | Compiles the production bundle for the React app. |
| `npm run lint` | Runs ESLint to check for code format issues. |

---

## 📁 Key File Structure

*   `server.js`: The Express server. Configures multer uploads, spawns the tracking script asynchronously, and maintains the tracking job state.
*   `src/App.jsx`: The core React dashboard codebase containing views for running analytics, uploading videos, and viewing run history.
*   `src/App.css`: Visual styling overrides.
*   `public/`: Houses static public assets including final tracked videos and compiled data CSVs.
