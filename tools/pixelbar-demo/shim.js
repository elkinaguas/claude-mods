// Stand-in for the 'claude-code' module: the state helpers over the fake $.state.
export function atom(ref, initial) {
  return { ref, initial }
}

export async function read($, a) {
  const { value } = await $.state.get(a.ref)
  return value === undefined ? a.initial : value
}

export async function update($, a, fn) {
  const next = fn(await read($, a))
  await $.state.set({ ...a.ref, value: next })
  return next
}
