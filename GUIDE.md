stackconsolev2/
├── config/                         # System engine configurations
│   └── projects.json               # Shared workspaces state/database persistence
├── src/                            # Central Core Source Code Directory
│   ├── main/                       # Desktop Platform Process (Electron Main)
│   │   ├── main.js                 # Core engine bootstrapper, window routers & IPC
│   │   └── preload.js              # Secure isolated contextBridge APIs expose layer
│   │
│   ├── services/                   # Heavy-lifting Process Controllers & Workers
│   │   └── process_streamer.py     # Refactored stream_worker.py (handles active IO)
│   │
│   └── renderer/                   # Visual Application Surface Layer (UI Window Contexts)
│       ├── assets/                 # Shared graphical binary components
│       │   └── logo.ico            # Core execution branding icon
│       ├── components/             # Sub-window components/modals
│       │   ├── add-command.html    
│       │   ├── add-project.html    
│       │   ├── edit-command.html   
│       │   └── project-manager.html
│       ├── index.html              # Main workspace frame entry point
│       ├── app.js                  # Refactored renderer.js (UI interactions)
│       ├── style.css               # Central Radix-styled design systems rulebook
│       └── utils/                  # Transpilation wrappers and text filters
│           └── ansi-parser.js      # Shell raw escape sequence parser formatting util
│
├── node_modules/                   # Node environment dependency tree
├── package.json                    # Application metadata manifest
└── package-lock.json               # System environment dependency lock snapshot