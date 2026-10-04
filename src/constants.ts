// Shared between the main process and the renderer.

/**
 * Session partition used by both player <webview>s and the Google login window.
 * Sharing one partition means a single login (cookies) applies to both players.
 */
export const PLAYER_PARTITION = 'persist:player';
