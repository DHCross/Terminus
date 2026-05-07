// setup-styles.js - CSS for setup wizard

export function injectSetupStyles() {
  if (document.getElementById('setup-wizard-styles')) return;

  const style = document.createElement('style');
  style.id = 'setup-wizard-styles';
  style.textContent = `
    /* ========================================
       Setup Wizard Modal Overlay
       ======================================== */
    .setup-wizard-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease;
      backdrop-filter: blur(4px);
    }
    .setup-wizard-overlay.active {
      opacity: 1;
    }

    /* ========================================
       Main Modal Container
       ======================================== */
    .setup-wizard {
      background: var(--bg-secondary);
      border-radius: 16px;
      width: 95%;
      max-width: 640px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.5);
      transform: translateY(20px);
      transition: transform 0.3s ease;
      overflow: hidden;
    }
    .setup-wizard-overlay.active .setup-wizard {
      transform: translateY(0);
    }

    /* ========================================
       Header
       ======================================== */
    .setup-wizard-header {
      padding: 24px 28px 16px;
      border-bottom: 1px solid var(--border);
      text-align: center;
    }
    .setup-wizard-header h2 {
      margin: 0 0 8px;
      font-size: 1.75rem;
      font-weight: 600;
      color: var(--text);
    }
    .setup-wizard-header .subtitle {
      margin: 0;
      font-size: 0.95rem;
      color: var(--text-muted);
      line-height: 1.5;
    }

    /* ========================================
       Step Indicators
       ======================================== */
    .setup-steps {
      display: flex;
      justify-content: center;
      gap: 8px;
      padding: 16px 28px;
      background: var(--bg-dark);
    }
    .setup-step {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.85rem;
      color: var(--text-muted);
      background: transparent;
      transition: all 0.2s ease;
    }
    .setup-step.active {
      background: var(--trim);
      color: #fff !important;
    }
    .setup-step.active .step-label {
      color: #fff;
    }
    .setup-step.completed {
      color: var(--success);
    }
    .setup-step.active.completed {
      color: #fff;
    }
    .setup-step .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.8rem;
      background: var(--bg-hover);
    }
    .setup-step.active .step-num {
      background: rgba(255,255,255,0.2);
    }
    .setup-step.completed .step-num {
      background: var(--success);
      color: #fff;
    }

    /* ========================================
       Content Area
       ======================================== */
    .setup-wizard-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 28px;
    }
    .setup-tab {
      display: none;
    }
    .setup-tab.active {
      display: block;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Tab headers */
    .setup-tab-header {
      text-align: center;
      margin-bottom: 24px;
    }
    .setup-tab-header h3 {
      margin: 0 0 8px;
      font-size: 1.3rem;
      color: var(--text);
    }
    .setup-tab-header p {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    /* ========================================
       Feature Cards (Voice tab)
       ======================================== */
    .feature-card {
      background: var(--bg-dark);
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      transition: all 0.2s ease;
    }
    .feature-card.enabled {
      border-color: var(--success);
      background: rgba(92, 184, 92, 0.1);
    }
    .feature-card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .feature-icon {
      font-size: 1.8rem;
    }
    .feature-info {
      flex: 1;
    }
    .feature-info h4 {
      margin: 0 0 4px;
      font-size: 1.1rem;
      color: var(--text);
    }
    .feature-info p {
      margin: 0;
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    /* Toggle switch */
    .feature-toggle {
      position: relative;
      width: 52px;
      height: 28px;
    }
    .feature-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .feature-toggle .slider {
      position: absolute;
      inset: 0;
      background: var(--bg-hover);
      border-radius: 28px;
      cursor: pointer;
      transition: 0.3s;
    }
    .feature-toggle .slider:before {
      content: '';
      position: absolute;
      width: 22px;
      height: 22px;
      left: 3px;
      bottom: 3px;
      background: #fff;
      border-radius: 50%;
      transition: 0.3s;
    }
    .feature-toggle input:checked + .slider {
      background: var(--success);
    }
    .feature-toggle input:checked + .slider:before {
      transform: translateX(24px);
    }

    /* Package status */
    .package-status {
      margin-top: 12px;
      padding: 12px;
      border-radius: 8px;
      font-size: 0.85rem;
    }
    .package-status.installed {
      background: rgba(92, 184, 92, 0.15);
      color: var(--success);
    }
    .package-status.not-installed {
      background: rgba(240, 173, 78, 0.15);
      color: var(--warning);
    }
    .package-status.checking {
      background: rgba(74, 158, 255, 0.1);
      color: var(--text-muted);
    }
    .package-status.checking .spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .pip-command {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding: 8px 12px;
      background: var(--input-bg);
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.8rem;
    }
    .pip-command code {
      flex: 1;
      color: var(--text);
    }
    .pip-command .copy-btn {
      padding: 4px 8px;
      font-size: 0.75rem;
      background: var(--trim);
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .pip-command .copy-btn:hover {
      opacity: 0.9;
    }

    /* Provider dropdown (STT, future TTS) */
    .provider-select {
      padding: 8px 12px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.85rem;
      cursor: pointer;
      min-width: 160px;
    }
    .provider-select:focus {
      outline: none;
      border-color: var(--trim);
    }

    /* API key row (cloud providers) */
    .provider-key-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      padding: 12px;
      background: rgba(74, 158, 255, 0.08);
      border-radius: 8px;
    }
    .provider-key-input {
      flex: 1;
      padding: 10px 12px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 0.9rem;
    }
    .provider-key-input:focus {
      outline: none;
      border-color: var(--trim);
    }
    .provider-key-input::placeholder {
      color: var(--text-dim);
    }
    .key-status {
      font-size: 0.85rem;
      white-space: nowrap;
    }

    /* Setup wizard info tip (not .help-tip — that's a 15px tooltip in main CSS) */
    .setup-tip {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 16px;
      background: rgba(74, 158, 255, 0.1);
      border-left: 3px solid var(--trim);
      border-radius: 0 8px 8px 0;
      margin: 16px 0;
      font-size: 0.85rem;
      color: var(--text-tertiary);
    }
    .setup-tip .tip-icon {
      font-size: 1.1rem;
    }

    /* ========================================
       Audio Devices (Audio tab)
       ======================================== */
    .audio-section {
      margin-bottom: 24px;
    }
    .audio-section h4 {
      margin: 0 0 8px;
      font-size: 1rem;
      color: var(--text);
    }
    .audio-section > p {
      margin: 0 0 12px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .device-row {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .device-select {
      flex: 1;
      padding: 10px 14px;
      background: var(--bg-dark);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.9rem;
    }
    .test-result {
      margin-top: 8px;
      font-size: 0.85rem;
      min-height: 20px;
    }
    .test-result.success { color: var(--success); }
    .test-result.warning { color: var(--warning); }
    .test-result.error { color: var(--error); }

    .level-meter-container {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 8px;
    }
    .level-meter {
      flex: 1;
      height: 8px;
      background: var(--bg-hover);
      border-radius: 4px;
      overflow: hidden;
    }
    .level-bar {
      height: 100%;
      width: 0%;
      background: var(--success);
      transition: width 0.1s;
    }
    .level-value {
      font-size: 0.8rem;
      color: var(--text-muted);
      min-width: 35px;
    }

    /* ========================================
       LLM Providers (LLM tab)
       ======================================== */
    .llm-intro {
      text-align: center;
      margin-bottom: 20px;
    }
    .llm-intro p {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .provider-simple-card {
      background: var(--bg-dark);
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .provider-simple-card:hover {
      border-color: var(--trim);
    }
    .provider-simple-card.selected {
      border-color: var(--success);
      background: rgba(92, 184, 92, 0.1);
    }
    .provider-simple-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .provider-simple-header .icon {
      font-size: 1.5rem;
    }
    .provider-simple-header .info {
      flex: 1;
    }
    .provider-simple-header .info h4 {
      margin: 0 0 2px;
      font-size: 1rem;
      color: var(--text);
    }
    .provider-simple-header .info p {
      margin: 0;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .provider-simple-header .check {
      font-size: 1.2rem;
      color: var(--success);
      opacity: 0;
      transition: opacity 0.2s;
    }
    .provider-simple-card.selected .check {
      opacity: 1;
    }

    .provider-config {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      display: none;
    }
    .provider-simple-card.selected .provider-config {
      display: block;
      animation: fadeIn 0.2s ease;
    }
    .config-field {
      margin-bottom: 12px;
    }
    .config-field label {
      display: block;
      margin-bottom: 6px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .config-field input,
    .config-field select {
      width: 100%;
      padding: 10px 12px;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 0.9rem;
    }
    .config-field input:focus,
    .config-field select:focus {
      outline: none;
      border-color: var(--trim);
    }
    .config-field .hint {
      margin-top: 4px;
      font-size: 0.75rem;
      color: var(--text-dim);
    }

    .test-connection-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 16px;
    }
    .test-connection-result {
      flex: 1;
      font-size: 0.85rem;
    }

    /* ========================================
       Footer Navigation
       ======================================== */
    .setup-wizard-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 28px;
      border-top: 1px solid var(--border);
      background: var(--bg-dark);
    }
    .setup-wizard-footer .btn {
      padding: 10px 24px;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      border: none;
    }
    .setup-wizard-footer .btn-secondary {
      background: var(--bg-hover);
      color: var(--text-muted);
    }
    .setup-wizard-footer .btn-secondary:hover {
      background: var(--bg-hover);
      color: var(--text);
    }
    .setup-wizard-footer .btn-primary {
      background: var(--trim);
      color: #fff;
    }
    .setup-wizard-footer .btn-primary:hover {
      background: #3a8eef;
    }
    .setup-wizard-footer .btn-success {
      background: var(--success);
      color: #fff;
    }
    .setup-wizard-footer .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .footer-hint {
      font-size: 0.8rem;
      color: var(--text-dim);
    }

    /* ========================================
       Responsive
       ======================================== */
    @media (max-width: 600px) {
      .setup-wizard {
        max-height: 95vh;
        border-radius: 12px;
      }
      .setup-wizard-header {
        padding: 16px 20px 12px;
      }
      .setup-wizard-content {
        padding: 16px 20px;
      }
      .setup-steps {
        padding: 12px 16px;
        gap: 4px;
      }
      .setup-step {
        padding: 6px 10px;
        font-size: 0.8rem;
      }
      .setup-step .step-label {
        display: none;
      }
    }

    /* ========================================
       Identity Tab
       ======================================== */
    .identity-section {
      display: flex;
      flex-direction: column;
      gap: 24px;
      max-width: 400px;
      margin: 0 auto;
      padding: 20px 0;
    }
    
    .identity-field {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .identity-field label {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--text);
    }
    
    .identity-input {
      padding: 14px 16px;
      font-size: 1.1rem;
      background: var(--input-bg);
      border: 2px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    
    .identity-input:focus {
      outline: none;
      border-color: var(--trim);
      box-shadow: 0 0 0 3px rgba(74, 158, 255, 0.2);
    }
    
    .identity-input::placeholder {
      color: var(--text-dim);
    }

    /* ========================================
       Success Celebration
       ======================================== */
    .success-screen {
      text-align: center;
      padding: 60px 20px;
    }
    .success-screen h3 {
      margin: 0 0 8px;
      color: var(--text);
      font-size: 1.5rem;
      animation: slideUp 0.5s ease 0.3s both;
    }
    .success-screen p {
      color: var(--text-muted);
      margin: 0;
      animation: slideUp 0.5s ease 0.4s both;
    }
    
    .celebration {
      position: relative;
      width: 120px;
      height: 120px;
      margin: 0 auto 24px;
    }
    
    .success-icon {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0);
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, var(--success), #3d9140);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.5rem;
      color: #fff;
      animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) 0.1s forwards;
      box-shadow: 0 4px 20px rgba(92, 184, 92, 0.4);
    }
    
    .sparkle {
      position: absolute;
      font-size: 1.2rem;
      color: var(--trim);
      opacity: 0;
      animation: sparkle 0.6s ease-out forwards;
    }
    .sparkle.s1 { top: 10%; left: 50%; animation-delay: 0.2s; color: #ffd700; }
    .sparkle.s2 { top: 25%; left: 85%; animation-delay: 0.25s; color: var(--success); }
    .sparkle.s3 { top: 70%; left: 90%; animation-delay: 0.3s; color: #ff6b9d; }
    .sparkle.s4 { top: 85%; left: 50%; animation-delay: 0.35s; color: #ffd700; }
    .sparkle.s5 { top: 70%; left: 10%; animation-delay: 0.4s; color: var(--trim); }
    .sparkle.s6 { top: 25%; left: 15%; animation-delay: 0.45s; color: #ff6b9d; }
    
    @keyframes popIn {
      0% { transform: translate(-50%, -50%) scale(0); }
      50% { transform: translate(-50%, -50%) scale(1.1); }
      100% { transform: translate(-50%, -50%) scale(1); }
    }
    
    @keyframes sparkle {
      0% { 
        opacity: 0; 
        transform: scale(0) translate(0, 0); 
      }
      50% { 
        opacity: 1; 
      }
      100% { 
        opacity: 0; 
        transform: scale(1.5) translate(
          calc((var(--x, 0) - 50%) * 0.5),
          calc((var(--y, 0) - 50%) * 0.5)
        );
      }
    }
    
    .sparkle.s1 { --x: 50%; --y: -30%; }
    .sparkle.s2 { --x: 120%; --y: 20%; }
    .sparkle.s3 { --x: 110%; --y: 100%; }
    .sparkle.s4 { --x: 50%; --y: 130%; }
    .sparkle.s5 { --x: -20%; --y: 100%; }
    .sparkle.s6 { --x: -10%; --y: 20%; }
    
    @keyframes slideUp {
      from { 
        opacity: 0; 
        transform: translateY(10px); 
      }
      to { 
        opacity: 1; 
        transform: translateY(0); 
      }
    }
  `;

  document.head.appendChild(style);
}