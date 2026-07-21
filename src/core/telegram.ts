/**
 * Telegram WebApp SDK Wrapper & Helpers
 */

interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
}

interface TelegramWebApp {
  ready: () => void
  expand: () => void
  close: () => void
  MainButton: {
    text: string
    color: string
    textColor: string
    isVisible: boolean
    isActive: boolean
    show: () => void
    hide: () => void
    enable: () => void
    disable: () => void
    onClick: (callback: () => void) => void
    offClick: (callback: () => void) => void
  }
  HapticFeedback: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void
    selectionChanged: () => void
  }
  initData: string
  initDataUnsafe: {
    query_id?: string
    user?: TelegramUser
    auth_date?: string
    hash?: string
  }
  setHeaderColor: (color: string) => void
  setBackgroundColor: (color: string) => void
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp
    }
  }
}

export const tg = {
  /** Check if the app is currently running inside Telegram */
  isInsideTelegram(): boolean {
    return typeof window !== 'undefined' && !!window.Telegram?.WebApp?.initData
  },

  /** Access the raw Telegram WebApp instance */
  get webApp(): TelegramWebApp | null {
    return typeof window !== 'undefined' ? window.Telegram?.WebApp || null : null
  },

  /** Get authenticated Telegram user profile */
  getUser(): TelegramUser | null {
    return this.webApp?.initDataUnsafe?.user || null
  },

  /** Initialize WebApp viewport and settings */
  init(): void {
    const app = this.webApp
    if (!app) return

    app.ready()
    app.expand()
    
    // Theme alignment matching Viva Maya's warm off-white cream palette
    try {
      app.setHeaderColor('#f6f3ec')
      app.setBackgroundColor('#f6f3ec')
    } catch {
      // Best-effort
    }
  },

  /** Trigger subtle haptic feedback for user actions */
  hapticImpact(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'medium'): void {
    try {
      this.webApp?.HapticFeedback?.impactOccurred(style)
    } catch {
      // Best-effort
    }
  },

  /** Trigger notification-based haptic alerts */
  hapticNotification(type: 'error' | 'success' | 'warning'): void {
    try {
      this.webApp?.HapticFeedback?.notificationOccurred(type)
    } catch {
      // Best-effort
    }
  }
}
