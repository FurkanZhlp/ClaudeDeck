import { describe, expect, it } from 'vitest'
import { LAUNCHED_AT_LOGIN_ARG, loginItemSettings, wasOpenedAtLogin } from './loginItem'
import { TITLE_BAR_HEIGHT, titleBarOverlay, windowChrome } from './windowChrome'

describe('windowChrome', () => {
  it('keeps the macOS inset traffic lights unchanged', () => {
    expect(windowChrome('darwin', false)).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 }
    })
    expect(windowChrome('darwin', true)).toEqual(windowChrome('darwin', false))
  })
  it('uses a caption button overlay with the theme colours on Windows', () => {
    expect(windowChrome('win32', false)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#efeeea', symbolColor: '#1d1d1b', height: TITLE_BAR_HEIGHT },
      backgroundColor: '#f7f7f5'
    })
    expect(windowChrome('win32', true)).toMatchObject({
      titleBarOverlay: { color: '#141413', symbolColor: '#ecebe6' },
      backgroundColor: '#1a1a18'
    })
  })
  it('matches the 44px title strip', () => {
    expect(titleBarOverlay(true).height).toBe(44)
  })
})

describe('loginItem', () => {
  it('adds the launch marker only on Windows', () => {
    expect(loginItemSettings('darwin', true)).toEqual({ openAtLogin: true })
    expect(loginItemSettings('win32', false)).toEqual({
      openAtLogin: false,
      args: [LAUNCHED_AT_LOGIN_ARG]
    })
  })
  it('detects a login launch from argv on Windows', () => {
    const mac = (): { wasOpenedAtLogin: boolean } => ({ wasOpenedAtLogin: true })
    expect(wasOpenedAtLogin('win32', ['ClaudeDeck.exe', LAUNCHED_AT_LOGIN_ARG], mac)).toBe(true)
    expect(wasOpenedAtLogin('win32', ['ClaudeDeck.exe'], mac)).toBe(false)
  })
  it('uses wasOpenedAtLogin on macOS and tolerates errors', () => {
    expect(wasOpenedAtLogin('darwin', [], () => ({ wasOpenedAtLogin: true }))).toBe(true)
    expect(wasOpenedAtLogin('darwin', [LAUNCHED_AT_LOGIN_ARG], () => ({}))).toBe(false)
    expect(
      wasOpenedAtLogin('darwin', [], () => {
        throw new Error('boom')
      })
    ).toBe(false)
    expect(wasOpenedAtLogin('linux', [LAUNCHED_AT_LOGIN_ARG], () => ({}))).toBe(false)
  })
})
