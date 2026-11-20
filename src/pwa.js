if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' }).catch(error => {
    console.warn('Não foi possível preparar o aplicativo para uso offline.', error)
  })
}
