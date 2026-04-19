// boot.js — minimal: just wait for SSE sweep complete, then redirect to jarvis.html
window.onSSE = (data) => {
  if (data.type === 'update' && data.sweepComplete) {
    location.href = '/jarvis.html';
  }
};
connectSSE();
