// Unified Notification System for ColEx
// This provides sleek, modern notifications instead of browser alerts

class NotificationSystem {
  constructor() {
    this.container = null;
    this.init();
  }

  init() {
    if (!document.getElementById('notification-container')) {
      this.container = document.createElement('div');
      this.container.id = 'notification-container';
      this.container.className = 'notification-container';
      document.body.appendChild(this.container);
    } else {
      this.container = document.getElementById('notification-container');
    }
  }

  show(message, type = 'info', duration = 4000) {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    
    const icons = { success: 'OK', error: 'X', warning: '!', info: 'i' };
    
    notification.innerHTML = `
      <div class="notification-icon">${icons[type] || icons.info}</div>
      <div class="notification-message">${message}</div>
      <button class="notification-close" onclick="this.parentElement.remove()">×</button>
    `;
    
    this.container.appendChild(notification);
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, duration);
    
    return notification;
  }

  success(message, duration) { return this.show(message, 'success', duration); }
  error(message, duration)   { return this.show(message, 'error',   duration); }
  warning(message, duration) { return this.show(message, 'warning', duration); }
  info(message, duration)    { return this.show(message, 'info',    duration); }

  confirm(message, onConfirm, onCancel) {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-modal-overlay"></div>
      <div class="confirm-modal-content">
        <div class="confirm-modal-icon">!</div>
        <div class="confirm-modal-message">${message}</div>
        <div class="confirm-modal-buttons">
          <button class="confirm-btn confirm-cancel">Cancel</button>
          <button class="confirm-btn confirm-yes">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);

    const cleanup = () => {
      modal.classList.remove('show');
      setTimeout(() => modal.remove(), 300);
    };
    modal.querySelector('.confirm-cancel').onclick = () => { cleanup(); if (onCancel) onCancel(); };
    modal.querySelector('.confirm-yes').onclick    = () => { cleanup(); if (onConfirm) onConfirm(); };
    modal.querySelector('.confirm-modal-overlay').onclick = () => { cleanup(); if (onCancel) onCancel(); };
  }

  prompt(message, defaultValue = '', onConfirm, onCancel) {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-modal-overlay"></div>
      <div class="confirm-modal-content">
        <div class="confirm-modal-icon">!</div>
        <div class="confirm-modal-message">${message}</div>
        <input type="text" class="confirm-modal-input" value="${defaultValue}" placeholder="Enter value...">
        <div class="confirm-modal-buttons">
          <button class="confirm-btn confirm-cancel">Cancel</button>
          <button class="confirm-btn confirm-yes">Submit</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);

    const input = modal.querySelector('.confirm-modal-input');
    input.focus();

    const cleanup = () => { modal.classList.remove('show'); setTimeout(() => modal.remove(), 300); };
    modal.querySelector('.confirm-cancel').onclick = () => { cleanup(); if (onCancel) onCancel(); };
    const submitAction = () => { const v = input.value.trim(); cleanup(); if (onConfirm) onConfirm(v); };
    modal.querySelector('.confirm-yes').onclick = submitAction;
    input.addEventListener('keypress', e => { if (e.key === 'Enter') submitAction(); });
    modal.querySelector('.confirm-modal-overlay').onclick = () => { cleanup(); if (onCancel) onCancel(); };
  }
}

window.notify = new NotificationSystem();

//  Fix #12: guard against duplicate style injection 
if (!document.getElementById('notification-styles')) {
  const notificationStyles = document.createElement('style');
  notificationStyles.id = 'notification-styles';
  notificationStyles.textContent = `
    .notification-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 400px;
      pointer-events: none;
    }

    .notification {
      display: flex;
      align-items: center;
      gap: 12px;
      background: white;
      padding: 16px 20px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      border-left: 4px solid #000;
      opacity: 0;
      transform: translateX(400px);
      transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
      pointer-events: all;
      min-width: 300px;
    }

    .notification.show { opacity: 1; transform: translateX(0); }

    .notification-icon {
      width: 28px; height: 28px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: bold; flex-shrink: 0;
    }

    .notification-success { border-left-color: #28a745; }
    .notification-success .notification-icon { background: #28a745; color: white; }
    .notification-error   { border-left-color: #dc3545; }
    .notification-error   .notification-icon { background: #dc3545; color: white; }
    .notification-warning { border-left-color: #ffc107; }
    .notification-warning .notification-icon { background: #ffc107; color: #000; }
    .notification-info    { border-left-color: #000; }
    .notification-info    .notification-icon { background: #000; color: white; }

    .notification-message {
      flex: 1; color: #333; font-size: 14px; line-height: 1.5; font-weight: 500;
    }

    .notification-close {
      background: transparent; border: none; color: #999;
      font-size: 24px; cursor: pointer; padding: 0;
      width: 24px; height: 24px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%; transition: all 0.2s; flex-shrink: 0;
    }
    .notification-close:hover { background: #f0f0f0; color: #000; }

    .confirm-modal {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 999998;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.3s;
    }
    .confirm-modal.show { opacity: 1; }

    .confirm-modal-overlay {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
    }

    .confirm-modal-content {
      position: relative; background: white; border-radius: 16px;
      padding: 32px; max-width: 440px; width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      transform: scale(0.9); transition: transform 0.3s; text-align: center;
    }
    .confirm-modal.show .confirm-modal-content { transform: scale(1); }

    .confirm-modal-icon {
      width: 64px; height: 64px; border-radius: 50%;
      background: #ffc107; color: #000;
      display: flex; align-items: center; justify-content: center;
      font-size: 32px; margin: 0 auto 20px;
    }

    .confirm-modal-message {
      font-size: 18px; color: #333; margin-bottom: 24px;
      line-height: 1.5; font-weight: 500;
    }

    .confirm-modal-input {
      width: 100%; padding: 12px 16px;
      border: 2px solid #e0e0e0; border-radius: 8px;
      font-size: 16px; margin-bottom: 24px; transition: border-color 0.3s;
    }
    .confirm-modal-input:focus { outline: none; border-color: #000; }

    .confirm-modal-buttons { display: flex; gap: 12px; }

    .confirm-btn {
      flex: 1; padding: 14px 24px; border: none; border-radius: 8px;
      font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.3s;
    }
    .confirm-cancel { background: #f5f5f5; color: #333; }
    .confirm-cancel:hover { background: #e0e0e0; }
    .confirm-yes { background: black; color: white; }
    .confirm-yes:hover { background: #555; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }

    @media (max-width: 480px) {
      .notification-container { left: 10px; right: 10px; top: 10px; max-width: none; }
      .notification { min-width: auto; }
      .confirm-modal-content { padding: 24px; }
      .confirm-modal-icon { width: 56px; height: 56px; font-size: 28px; }
      .confirm-modal-message { font-size: 16px; }
    }
  `;
  document.head.appendChild(notificationStyles);
}
