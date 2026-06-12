stackconsolev2/
├── data/
│   └── projects.json               # Shared workspaces state/database persistence
├── services/
│   └── stream_worker.py             # Python process IO stream handler
├── src/
│   ├── assets/
│   │   └── logo/
│   │       ├── stacklogo.ico        # App icon (32x32)
│   │       └── stacklogo-x256.ico   # App icon (256x256, for installer)
│   ├── components/
│   │   ├── modals/
│   │   │   ├── add-command.html
│   │   │   ├── add-project.html
│   │   │   ├── edit-command.html
│   │   │   └── edit-project-name.html
│   │   └── project-manager.html
│   ├── util/
│   │   ├── ansi-parser.js           # Shell escape sequence parser
│   │   └── icon-map.js              # SVG icon registry for command avatars
│   ├── index.css                    # Central design system
│   ├── index.html                   # Main workspace frame entry point
│   └── main.js                      # UI interactions and layout renderer
├── main.js                          # Core engine bootstrapper, window routers & IPC
├── preload.js                       # Secure contextBridge APIs expose layer
├── package.json                     # Application metadata manifest
├── package-lock.json                # Dependency lock snapshot
├── release/
│   └── beta/
│       └── StackConsole-v1.0.0-beta.1-x64.exe
├── GUIDE.md
├── LICENSE
└── README.md