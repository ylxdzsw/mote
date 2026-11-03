export class DocumentEvents {
  constructor() { this.listeners = new Map() }

  subscribe(id, update, end) {
    let listeners = this.listeners.get(id)
    if (!listeners) this.listeners.set(id, listeners = new Set())
    const listener = { update, end }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(id)
    }
  }

  publish(id, update) {
    for (const listener of this.listeners.get(id) ?? []) listener.update(update)
  }

  end(id) {
    const listeners = this.listeners.get(id)
    this.listeners.delete(id)
    for (const listener of listeners ?? []) listener.end()
  }
}
