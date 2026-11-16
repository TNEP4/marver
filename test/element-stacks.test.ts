// The frame host holds React's element stacks while a frame's modules load (inplace.ts, holdElementStacks): elements made then share
// React's unknown-owner stack, and the count afterwards is back where it was.
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { holdElementStacks } from '../src/client/frame-host/inplace.ts'

type Dev = { _debugStack?: unknown; _debugTask?: unknown }
const internals = (React as unknown as Record<string, { recentlyCreatedOwnerStacks: number }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
const make = () => React.createElement('i') as unknown as Dev

describe('holdElementStacks', () => {
  it('runs against React development build that counts element stacks', () => {
    expect(typeof internals.recentlyCreatedOwnerStacks).toBe('number')
    internals.recentlyCreatedOwnerStacks = 0
    const a = make(), b = make()
    expect(a._debugStack).toBeInstanceOf(Error)
    expect(a._debugStack).not.toBe(b._debugStack)   // each its own
  })

  it('gives elements made during the hold the one shared stack and task, and none of their own', () => {
    internals.recentlyCreatedOwnerStacks = 0
    const outside = make()
    const give = holdElementStacks(React)
    const held = [make(), make(), React.createElement('b', null, React.createElement('c')) as unknown as Dev]
    give()
    expect(held[0]._debugStack).toBe(held[1]._debugStack)
    expect(held[0]._debugStack).toBe(held[2]._debugStack)
    expect(held[0]._debugTask).toBe(held[1]._debugTask)
    expect(held[0]._debugStack).not.toBe(outside._debugStack)
    // after: a stack of its own again
    const after = [make(), make()]
    expect(after[0]._debugStack).toBeInstanceOf(Error)
    expect(after[0]._debugStack).not.toBe(after[1]._debugStack)
    expect(after[0]._debugStack).not.toBe(held[0]._debugStack)
  })

  it('puts the count back where it was: the elements made during the hold spend none of the budget', () => {
    internals.recentlyCreatedOwnerStacks = 7
    const give = holdElementStacks(React)
    for (let i = 0; i < 20_000; i++) make()   // more than React's whole budget, as an icon barrel makes
    give()
    expect(internals.recentlyCreatedOwnerStacks).toBe(7)
    give()   // once
    expect(internals.recentlyCreatedOwnerStacks).toBe(7)
    expect(make()._debugStack).toBeInstanceOf(Error)   // the next element has a stack of its own
  })

  it('keeps the renderer\'s count if it reset it during the hold', () => {
    internals.recentlyCreatedOwnerStacks = 50
    const give = holdElementStacks(React)
    internals.recentlyCreatedOwnerStacks = 0   // what the renderer does at most once a second
    make()
    give()
    expect(internals.recentlyCreatedOwnerStacks).toBe(1)
  })

  it('leaves a React without the counter alone', () => {
    const prod = { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: null } }
    holdElementStacks(prod)()
    expect(prod.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE).toEqual({ H: null })
    expect(() => holdElementStacks({})()).not.toThrow()
  })
})
