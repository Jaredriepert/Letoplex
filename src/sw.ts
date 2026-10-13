/// <reference lib="webworker" />
// Service worker: caches the app shell for offline use and receives books
// shared to the installed app (Android share sheet → manifest share_target).
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { addToInbox } from './storage/db'

declare let self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Any navigation while offline gets the app shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

const scoped = (path: string) => new URL(path, self.registration.scope).href

const receiveShare = async (request: Request) => {
  try {
    const form = await request.formData()
    const files = form.getAll('book').filter((value): value is File => value instanceof File && value.size > 0)
    for (const file of files) {
      await addToInbox({ file, name: file.name, receivedAt: Date.now() })
    }
    if (files.length > 0) {
      return Response.redirect(scoped('./?shared=1'), 303)
    }
    // A shared link (e.g. to a .letoplex file) goes through the normal link import.
    const link = [form.get('url'), form.get('text')]
      .map((value) => (typeof value === 'string' ? value.match(/https?:\/\/\S+/)?.[0] : undefined))
      .find(Boolean)
    if (link) {
      return Response.redirect(scoped(`./?import=${encodeURIComponent(link)}`), 303)
    }
  } catch {
    // Fall through to opening the app normally.
  }
  return Response.redirect(scoped('./'), 303)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && url.href === scoped('./share-target')) {
    event.respondWith(receiveShare(event.request))
  }
})

// The page asks before activating an update, so a reader isn't reloaded mid-story.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})
