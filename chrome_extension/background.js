// background.js

let token = null;
let tokenExpire = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("refreshData", { periodInMinutes: 5 });
  console.log("Extension Logtime installée. Alarme créée.");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "refreshData") {
    await refreshAllData();
  }
});

// Listener pour que le popup puisse demander un rafraîchissement manuel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "refresh") {
    refreshAllData().then(() => sendResponse({status: "success"}));
    return true; // async response
  }
  if (request.action === "getToken") {
    getValidToken().then(t => sendResponse({token: t}));
    return true;
  }
});

async function getValidToken() {
  if (token && tokenExpire > (Date.now() / 1000)) {
    return token;
  }

  const settings = await chrome.storage.local.get(['apiUid', 'apiSecret']);
  if (!settings.apiUid || !settings.apiSecret) {
    console.warn("UID ou Secret manquant.");
    return null;
  }

  try {
    const res = await fetch('https://api.intra.42.fr/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: settings.apiUid,
        client_secret: settings.apiSecret
      })
    });
    const data = await res.json();
    if (data.access_token) {
      token = data.access_token;
      tokenExpire = (Date.now() / 1000) + data.expires_in - 60; // 1 min margin
      return token;
    }
  } catch (error) {
    console.error("Erreur de récupération du token:", error);
  }
  return null;
}

async function refreshAllData() {
  const currentToken = await getValidToken();
  if (!currentToken) return;

  const settings = await chrome.storage.local.get(['username', 'friendsList']);
  const username = settings.username;
  if (!username) return;

  const now = new Date();
  const startObj = new Date(now.getFullYear(), now.getMonth(), 1);
  const endObj = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
  // Format for Intra API
  // Using simplified strings
  const start = startObj.toISOString();
  const end = endObj.toISOString();

  try {
    // 1. Fetch Logtime
    const locsRes = await fetch(`https://api.intra.42.fr/v2/users/${username}/locations?range[begin_at]=${start},${end}&per_page=100`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const locs = await locsRes.json();
    
    // 2. Fetch Stats
    const statsRes = await fetch(`https://api.intra.42.fr/v2/users/${username}`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const stats = await statsRes.json();
    
    // 3. Update friends online count
    let onlineFriends = 0;
    const friendsStats = {};

    if (settings.friendsList && settings.friendsList.length > 0) {
      for (const friend of settings.friendsList) {
        try {
          const friendLocsRes = await fetch(`https://api.intra.42.fr/v2/users/${friend}/locations?range[begin_at]=${start},${end}&per_page=100`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
          });
          const friendLocs = await friendLocsRes.json();
          const activeSession = Array.isArray(friendLocs) && friendLocs.find(l => l.end_at === null);
          friendsStats[friend] = { active: activeSession ? activeSession.host : null, locs: friendLocs };
          if (activeSession) onlineFriends++;
        } catch(e) { console.error("Error friend", friend); }
      }
    }

    // Update badge with number of online friends
    if (onlineFriends > 0) {
      chrome.action.setBadgeText({ text: onlineFriends.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#00b894' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }

    // Cache everything
    await chrome.storage.local.set({
      cachedLocations: Array.isArray(locs) ? locs : [],
      cachedStats: stats,
      cachedFriends: friendsStats,
      lastRefresh: Date.now()
    });

  } catch (err) {
    console.error("Erreur lors du refresh:", err);
  }
}
