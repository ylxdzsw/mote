import { HttpError, UUID } from './validation.mjs'

export async function cloudApi(store, request, pathname, readBody) {
  const parts = pathname.split('/').slice(2)
  if (parts[0] === 'shared') {
    if (request.method !== 'GET' || parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new HttpError(404, 'share not found')
    return { status: 200, body: store.shared(parts[1]) }
  }
  const [, id, action, child] = parts
  if (parts.length > 4 || id && !UUID.test(id) || child && !UUID.test(child)) throw new HttpError(404, 'not found')
  const method = request.method
  let body
  let status = 200
  if (!id && parts.length === 1) {
    if (method === 'GET') body = store.list()
    else if (method === 'POST') { body = store.create(await readBody(request)); status = 201 }
  } else if (id && !action && parts.length === 2) {
    if (method === 'GET') body = store.get(id)
    else if (method === 'PUT') body = store.put(id, await readBody(request))
    else if (method === 'PATCH') body = store.rename(id, await readBody(request))
    else if (method === 'DELETE') body = store.delete(id, await readBody(request))
  } else if (action === 'privacy' && parts.length === 3) {
    if (method === 'GET') body = store.privacyMeta(id)
    else if (method === 'PUT') body = store.putPrivacy(id, await readBody(request))
  } else if (action === 'assistant' && parts.length === 3) {
    if (method === 'GET') body = store.assistant(id)
    else if (method === 'PUT') body = store.putAssistant(id, await readBody(request))
  } else if (action === 'shares') {
    if (method === 'GET' && !child) body = store.shares(id)
    else if (method === 'PUT' && !child) body = store.putShares(id, await readBody(request))
  }
  if (body === undefined) throw new HttpError(404, 'not found')
  return { status, body }
}
