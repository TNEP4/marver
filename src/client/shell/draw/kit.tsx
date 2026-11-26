/**
 * The drawing frame's controls (spec 38) - ported from the approved design kit (platform canvas,
 * design/scenes/drawing-frame/_kit.tsx): icons, the long-hover tooltip, menu rows, the property glyphs. Pure view
 * pieces; the live wiring is in DrawBar / DrawPanel / DrawView.
 */
import { cloneElement, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type SVGProps } from 'react'
import { CursorIcon, LaserIcon } from '../icons.tsx'
import type { DrawTool } from '../../../shared/draw-protocol.ts'
import { ROUTE } from '../../const.ts'
import './draw.css'

// Phosphor REGULAR path data (MIT (c) Phosphor Icons - phosphoricons.com)
const PH_D = {
  // spec 39 right-click (Phosphor Regular 2.1.1)
  Scissors: 'M157.73,113.13A8,8,0,0,1,159.82,102L227.48,55.7a8,8,0,0,1,9,13.21l-67.67,46.3a7.92,7.92,0,0,1-4.51,1.4A8,8,0,0,1,157.73,113.13Zm80.87,85.09a8,8,0,0,1-11.12,2.08L136,137.7,93.49,166.78a36,36,0,1,1-9-13.19L121.83,128,84.44,102.41a35.86,35.86,0,1,1,9-13.19l143,97.87A8,8,0,0,1,238.6,198.22ZM80,180a20,20,0,1,0-5.86,14.14A19.85,19.85,0,0,0,80,180ZM74.14,90.13a20,20,0,1,0-28.28,0A19.85,19.85,0,0,0,74.14,90.13Z',
  Clipboard: 'M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Zm-72,0a32,32,0,0,1,32,32H96A32,32,0,0,1,128,32Zm72,184H56V48H82.75A47.93,47.93,0,0,0,80,64v8a8,8,0,0,0,8,8h80a8,8,0,0,0,8-8V64a47.93,47.93,0,0,0-2.75-16H200Z',
  ClipboardText: 'M168,152a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,152Zm-8-40H96a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Zm56-64V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V48A16,16,0,0,1,56,32H92.26a47.92,47.92,0,0,1,71.48,0H200A16,16,0,0,1,216,48ZM96,64h64a32,32,0,0,0-64,0ZM200,48H173.25A47.93,47.93,0,0,1,176,64v8a8,8,0,0,1-8,8H88a8,8,0,0,1-8-8V64a47.93,47.93,0,0,1,2.75-16H56V216H200Z',
  FileSvg: 'M87.82,196.31a20.82,20.82,0,0,1-9.19,15.23C73.44,215,67,216,61.14,216A61.23,61.23,0,0,1,46,214a8,8,0,0,1,4.3-15.41c4.38,1.2,14.95,2.7,19.55-.36.88-.59,1.83-1.52,2.14-3.93.35-2.67-.71-4.1-12.78-7.59-9.35-2.7-25-7.23-23-23.11a20.55,20.55,0,0,1,9-14.95c11.84-8,30.72-3.31,32.83-2.76a8,8,0,0,1-4.07,15.48c-4.48-1.17-15.23-2.56-19.83.56a4.54,4.54,0,0,0-2,3.67c-.11.9-.14,1.09,1.12,1.9,2.31,1.49,6.44,2.68,10.45,3.84C73.5,174.17,90.06,179,87.82,196.31ZM216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,1,1-16,0V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.65,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Zm-13.3,64.47a8,8,0,0,0-10.23,4.84L124,184.21l-12.47-34.9a8,8,0,1,0-15.06,5.38l20,56a8,8,0,0,0,15.07,0l20-56A8,8,0,0,0,146.7,144.47ZM208,176h-8a8,8,0,0,0,0,16v5.29a13.38,13.38,0,0,1-8,2.71c-8.82,0-16-9-16-20s7.18-20,16-20a13.27,13.27,0,0,1,7.53,2.38,8,8,0,0,0,8.95-13.26A29.38,29.38,0,0,0,192,144c-17.64,0-32,16.15-32,36s14.36,36,32,36a30.06,30.06,0,0,0,21.78-9.6,8,8,0,0,0,2.22-5.53V184A8,8,0,0,0,208,176Z',
  TextAa: 'M87.24,52.59a8,8,0,0,0-14.48,0l-64,136a8,8,0,1,0,14.48,6.81L39.9,160h80.2l16.66,35.4a8,8,0,1,0,14.48-6.81ZM47.43,144,80,74.79,112.57,144ZM200,96c-12.76,0-22.73,3.47-29.63,10.32a8,8,0,0,0,11.26,11.36c3.8-3.77,10-5.68,18.37-5.68,13.23,0,24,9,24,20v3.22A42.76,42.76,0,0,0,200,128c-22.06,0-40,16.15-40,36s17.94,36,40,36a42.73,42.73,0,0,0,24-7.25,8,8,0,0,0,16-.75V132C240,112.15,222.06,96,200,96Zm0,88c-13.23,0-24-9-24-20s10.77-20,24-20,24,9,24,20S213.23,184,200,184Z',
  PaintBrush: 'M232,32a8,8,0,0,0-8-8c-44.08,0-89.31,49.71-114.43,82.63A60,60,0,0,0,32,164c0,30.88-19.54,44.73-20.47,45.37A8,8,0,0,0,16,224H92a60,60,0,0,0,57.37-77.57C182.3,121.31,232,76.08,232,32ZM92,208H34.63C41.38,198.41,48,183.92,48,164a44,44,0,1,1,44,44Zm32.42-94.45q5.14-6.66,10.09-12.55A76.23,76.23,0,0,1,155,121.49q-5.9,4.94-12.55,10.09A60.54,60.54,0,0,0,124.42,113.55Zm42.7-2.68a92.57,92.57,0,0,0-22-22c31.78-34.53,55.75-45,69.9-47.91C212.17,55.12,201.65,79.09,167.12,110.87Z',
  FlipHorizontal: 'M107.18,24.33a15.86,15.86,0,0,0-17.92,9.45l-.06.14-64,159.93A16,16,0,0,0,40,216h64a16,16,0,0,0,16-16V40A15.85,15.85,0,0,0,107.18,24.33ZM104,200H40l.06-.15L104,40Zm126.77-6.15-64-159.93-.06-.14A16,16,0,0,0,136,40V200a16,16,0,0,0,16,16h64a16,16,0,0,0,14.78-22.15ZM152,200V40l63.93,159.84.06.15Z',
  FlipVertical: 'M56,120H216a16,16,0,0,0,6.23-30.74l-.14-.06-159.93-64A16,16,0,0,0,40,40v64A16,16,0,0,0,56,120Zm0-80,.15.06L216,104H56l0-64Zm160,96H56a16,16,0,0,0-16,16v64a16,16,0,0,0,22.15,14.78l159.93-64,.14-.06A16,16,0,0,0,216,136ZM56.15,215.93,56,216V152H216Z',
  LinkBreak: 'M198.63,57.37a32,32,0,0,0-45.19-.06L141.79,69.52a8,8,0,0,1-11.58-11l11.72-12.29a1.59,1.59,0,0,1,.13-.13,48,48,0,0,1,67.88,67.88,1.59,1.59,0,0,1-.13.13l-12.29,11.72a8,8,0,0,1-11-11.58l12.21-11.65A32,32,0,0,0,198.63,57.37ZM114.21,186.48l-11.65,12.21a32,32,0,0,1-45.25-45.25l12.21-11.65a8,8,0,0,0-11-11.58L46.19,141.93a1.59,1.59,0,0,0-.13.13,48,48,0,0,0,67.88,67.88,1.59,1.59,0,0,0,.13-.13l11.72-12.29a8,8,0,1,0-11.58-11ZM216,152H192a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16ZM40,104H64a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16Zm120,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V192A8,8,0,0,0,160,184ZM96,72a8,8,0,0,0,8-8V40a8,8,0,0,0-16,0V64A8,8,0,0,0,96,72Z',
  LockKey: 'M128,112a28,28,0,0,0-8,54.83V184a8,8,0,0,0,16,0V166.83A28,28,0,0,0,128,112Zm0,40a12,12,0,1,1,12-12A12,12,0,0,1,128,152Zm80-72H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z',
  SelectionPlus: 'M152,40a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,40Zm-8,168H112a8,8,0,0,0,0,16h32a8,8,0,0,0,0-16ZM208,48V72a8,8,0,0,0,16,0V48a16,16,0,0,0-16-16H184a8,8,0,0,0,0,16Zm8,56a8,8,0,0,0-8,8v32a8,8,0,0,0,16,0V112A8,8,0,0,0,216,104ZM40,152a8,8,0,0,0,8-8V112a8,8,0,0,0-16,0v32A8,8,0,0,0,40,152Zm32,56H48V184a8,8,0,0,0-16,0v24a16,16,0,0,0,16,16H72a8,8,0,0,0,0-16ZM72,32H48A16,16,0,0,0,32,48V72a8,8,0,0,0,16,0V48H72a8,8,0,0,0,0-16ZM240,208H224V192a8,8,0,0,0-16,0v16H192a8,8,0,0,0,0,16h16v16a8,8,0,0,0,16,0V224h16a8,8,0,0,0,0-16Z',
  PenNib: 'M248,92.68a15.86,15.86,0,0,0-4.69-11.31L174.63,12.68a16,16,0,0,0-22.63,0L123.57,41.11l-58,21.77A16.06,16.06,0,0,0,55.35,75.23L32.11,214.68A8,8,0,0,0,40,224a8.4,8.4,0,0,0,1.32-.11l139.44-23.24a16,16,0,0,0,12.35-10.17l21.77-58L243.31,104A15.87,15.87,0,0,0,248,92.68Zm-69.87,92.19L63.32,204l47.37-47.37a28,28,0,1,0-11.32-11.32L52,192.7,71.13,77.86,126,57.29,198.7,130ZM112,132a12,12,0,1,1,12,12A12,12,0,0,1,112,132Zm96-15.32L139.31,48l24-24L232,92.68Z',
  Hand: 'M188,48a27.75,27.75,0,0,0-12,2.71V44a28,28,0,0,0-54.65-8.6A28,28,0,0,0,80,60v64l-3.82-6.13a28,28,0,0,0-48.6,27.82c16,33.77,28.93,57.72,43.72,72.69C86.24,233.54,103.2,240,128,240a88.1,88.1,0,0,0,88-88V76A28,28,0,0,0,188,48Zm12,104a72.08,72.08,0,0,1-72,72c-20.38,0-33.51-4.88-45.33-16.85C69.44,193.74,57.26,171,41.9,138.58a6.36,6.36,0,0,0-.3-.58,12,12,0,0,1,20.79-12,1.76,1.76,0,0,0,.14.23l18.67,30A8,8,0,0,0,96,152V60a12,12,0,0,1,24,0v60a8,8,0,0,0,16,0V44a12,12,0,0,1,24,0v76a8,8,0,0,0,16,0V76a12,12,0,0,1,24,0Z',
  LockSimple: 'M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z',
  LockSimpleOpen: 'M208,80H96V56a32,32,0,0,1,32-32c15.37,0,29.2,11,32.16,25.59a8,8,0,0,0,15.68-3.18C171.32,24.15,151.2,8,128,8A48.05,48.05,0,0,0,80,56V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80Zm0,128H48V96H208V208Z',
  Diamond: 'M235.33,116.72,139.28,20.66a16,16,0,0,0-22.56,0l-96,96.06a16,16,0,0,0,0,22.56l96.05,96.06h0a16,16,0,0,0,22.56,0l96.05-96.06a16,16,0,0,0,0-22.56ZM128,224h0L32,128,128,32,224,128Z',
  Circle: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z',
  Square: 'M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm0,176H48V48H208V208Z',
  ArrowRight: 'M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z',
  Minus: 'M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z',
  TextT: 'M208,56V88a8,8,0,0,1-16,0V64H136V192h24a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16h24V64H64V88a8,8,0,0,1-16,0V56a8,8,0,0,1,8-8H200A8,8,0,0,1,208,56Z',
  Eraser: 'M225,80.4,183.6,39a24,24,0,0,0-33.94,0L31,157.66a24,24,0,0,0,0,33.94l30.06,30.06A8,8,0,0,0,66.74,224H216a8,8,0,0,0,0-16h-84.7L225,114.34A24,24,0,0,0,225,80.4ZM108.68,208H70.05L42.33,180.28a8,8,0,0,1,0-11.31L96,115.31,148.69,168Zm105-105L160,156.69,107.31,104,161,50.34a8,8,0,0,1,11.32,0l41.38,41.38a8,8,0,0,1,0,11.31Z',
  Image: 'M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z',
  DotsThree: 'M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm56-12a12,12,0,1,0,12,12A12,12,0,0,0,196,116ZM60,116a12,12,0,1,0,12,12A12,12,0,0,0,60,116Z',
  Plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  ClockCounterClockwise: 'M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49c7.15-8.42,14.27-16.35,22.39-24.57a80,80,0,1,1,1.66,114.75,8,8,0,1,0-11,11.64A96,96,0,1,0,128,32Z',
  ArrowUUpLeft: 'M232,144a64.07,64.07,0,0,1-64,64H80a8,8,0,0,1,0-16h88a48,48,0,0,0,0-96H51.31l34.35,34.34a8,8,0,0,1-11.32,11.32l-48-48a8,8,0,0,1,0-11.32l48-48A8,8,0,0,1,85.66,45.66L51.31,80H168A64.07,64.07,0,0,1,232,144Z',
  ArrowUUpRight: 'M170.34,130.34,204.69,96H88a48,48,0,0,0,0,96h88a8,8,0,0,1,0,16H88A64,64,0,0,1,88,80H204.69L170.34,45.66a8,8,0,0,1,11.32-11.32l48,48a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32-11.32Z',
  Copy: 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z',
  Trash: 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z',
  Link: 'M240,88.23a54.43,54.43,0,0,1-16,37L189.25,160a54.27,54.27,0,0,1-38.63,16h-.05A54.63,54.63,0,0,1,96,119.84a8,8,0,0,1,16,.45A38.62,38.62,0,0,0,150.58,160h0a38.39,38.39,0,0,0,27.31-11.31l34.75-34.75a38.63,38.63,0,0,0-54.63-54.63l-11,11A8,8,0,0,1,135.7,59l11-11A54.65,54.65,0,0,1,224,48,54.86,54.86,0,0,1,240,88.23ZM109,185.66l-11,11A38.41,38.41,0,0,1,70.6,208h0a38.63,38.63,0,0,1-27.29-65.94L78,107.31A38.63,38.63,0,0,1,144,135.71a8,8,0,0,0,16,.45A54.86,54.86,0,0,0,144,96a54.65,54.65,0,0,0-77.27,0L32,130.75A54.62,54.62,0,0,0,70.56,224h0a54.28,54.28,0,0,0,38.64-16l11-11A8,8,0,0,0,109,185.66Z',
  Eyedropper: 'M224,67.3a35.79,35.79,0,0,0-11.26-25.66c-14-13.28-36.72-12.78-50.62,1.13L142.8,62.2a24,24,0,0,0-33.14.77l-9,9a16,16,0,0,0,0,22.64l2,2.06-51,51a39.75,39.75,0,0,0-10.53,38l-8,18.41A13.68,13.68,0,0,0,36,219.3a15.92,15.92,0,0,0,17.71,3.35L71.23,215a39.89,39.89,0,0,0,37.06-10.75l51-51,2.06,2.06a16,16,0,0,0,22.62,0l9-9a24,24,0,0,0,.74-33.18l19.75-19.87A35.75,35.75,0,0,0,224,67.3ZM97,193a24,24,0,0,1-24,6,8,8,0,0,0-5.55.31l-18.1,7.91L57,189.41a8,8,0,0,0,.25-5.75A23.88,23.88,0,0,1,63,159l51-51,33.94,34ZM202.13,82l-25.37,25.52a8,8,0,0,0,0,11.3l4.89,4.89a8,8,0,0,1,0,11.32l-9,9L112,83.26l9-9a8,8,0,0,1,11.31,0l4.89,4.89a8,8,0,0,0,11.33,0l24.94-25.09c7.81-7.82,20.5-8.18,28.29-.81a20,20,0,0,1,.39,28.7Z',
  CaretDown: 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
  CaretRight: 'M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z',
  TextAlignLeft: 'M32,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H40A8,8,0,0,1,32,64Zm8,48H168a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16Zm176,24H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm-48,40H40a8,8,0,0,0,0,16H168a8,8,0,0,0,0-16Z',
  TextAlignCenter: 'M32,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H40A8,8,0,0,1,32,64ZM64,96a8,8,0,0,0,0,16H192a8,8,0,0,0,0-16Zm152,40H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm-24,40H64a8,8,0,0,0,0,16H192a8,8,0,0,0,0-16Z',
  TextAlignRight: 'M32,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H40A8,8,0,0,1,32,64ZM216,96H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,40H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,40H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z',
  AlignLeft: 'M48,40V216a8,8,0,0,1-16,0V40a8,8,0,0,1,16,0Zm16,64V64A16,16,0,0,1,80,48h96a16,16,0,0,1,16,16v40a16,16,0,0,1-16,16H80A16,16,0,0,1,64,104Zm16,0h96V64H80Zm152,48v40a16,16,0,0,1-16,16H80a16,16,0,0,1-16-16V152a16,16,0,0,1,16-16H216A16,16,0,0,1,232,152Zm-16,40V152H80v40H216Z',
  AlignCenterHorizontal: 'M208,136H136V120h48a16,16,0,0,0,16-16V64a16,16,0,0,0-16-16H136V32a8,8,0,0,0-16,0V48H72A16,16,0,0,0,56,64v40a16,16,0,0,0,16,16h48v16H48a16,16,0,0,0-16,16v40a16,16,0,0,0,16,16h72v16a8,8,0,0,0,16,0V208h72a16,16,0,0,0,16-16V152A16,16,0,0,0,208,136ZM72,64H184v40H72ZM208,192H48V152H208v40Z',
  AlignRight: 'M224,40V216a8,8,0,0,1-16,0V40a8,8,0,0,1,16,0ZM192,64v40a16,16,0,0,1-16,16H80a16,16,0,0,1-16-16V64A16,16,0,0,1,80,48h96A16,16,0,0,1,192,64Zm-16,0H80v40h96Zm16,88v40a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V152a16,16,0,0,1,16-16H176A16,16,0,0,1,192,152Zm-16,0H40v40H176Z',
  AlignTop: 'M224,40a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,40ZM208,80v96a16,16,0,0,1-16,16H152a16,16,0,0,1-16-16V80a16,16,0,0,1,16-16h40A16,16,0,0,1,208,80Zm-16,0H152v96h40Zm-72,0V216a16,16,0,0,1-16,16H64a16,16,0,0,1-16-16V80A16,16,0,0,1,64,64h40A16,16,0,0,1,120,80Zm-16,0H64V216h40Z',
  AlignCenterVertical: 'M224,120H208V72a16,16,0,0,0-16-16H152a16,16,0,0,0-16,16v48H120V48a16,16,0,0,0-16-16H64A16,16,0,0,0,48,48v72H32a8,8,0,0,0,0,16H48v72a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V136h16v48a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V136h16a8,8,0,0,0,0-16ZM104,208H64V48h40Zm88-24H152V72h40Z',
  AlignBottom: 'M224,216a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,216Zm-88-40V80a16,16,0,0,1,16-16h40a16,16,0,0,1,16,16v96a16,16,0,0,1-16,16H152A16,16,0,0,1,136,176Zm16,0h40V80H152ZM48,176V40A16,16,0,0,1,64,24h40a16,16,0,0,1,16,16V176a16,16,0,0,1-16,16H64A16,16,0,0,1,48,176Zm16,0h40V40H64Z',
  MagnifyingGlass: 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  Check: 'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z',
  Hash: 'M224,88H175.4l8.47-46.57a8,8,0,0,0-15.74-2.86l-9,49.43H111.4l8.47-46.57a8,8,0,0,0-15.74-2.86L95.14,88H48a8,8,0,0,0,0,16H92.23L83.5,152H32a8,8,0,0,0,0,16H80.6l-8.47,46.57a8,8,0,0,0,6.44,9.3A7.79,7.79,0,0,0,80,224a8,8,0,0,0,7.86-6.57l9-49.43H144.6l-8.47,46.57a8,8,0,0,0,6.44,9.3A7.79,7.79,0,0,0,144,224a8,8,0,0,0,7.86-6.57l9-49.43H208a8,8,0,0,0,0-16H163.77l8.73-48H224a8,8,0,0,0,0-16Zm-76.5,64H99.77l8.73-48h47.73Z',
  Code: 'M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z',
  ArrowLineDown: 'M50.34,117.66a8,8,0,0,1,11.32-11.32L120,164.69V32a8,8,0,0,1,16,0V164.69l58.34-58.35a8,8,0,0,1,11.32,11.32l-72,72a8,8,0,0,1-11.32,0ZM216,208H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z',
  ArrowDown: 'M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z',
  ArrowLeft: 'M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z',
  ArrowUp: 'M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z',
  ArrowLineUp: 'M205.66,138.34a8,8,0,0,1-11.32,11.32L136,91.31V224a8,8,0,0,1-16,0V91.31L61.66,149.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0ZM216,32H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z',
  FilePng: 'M60,144H44a8,8,0,0,0-8,8v56a8,8,0,0,0,16,0v-8h8a28,28,0,0,0,0-56Zm0,40H52V160h8a12,12,0,0,1,0,24Zm164,16.87a8,8,0,0,1-2.22,5.53A30.06,30.06,0,0,1,200,216c-17.65,0-32-16.15-32-36s14.35-36,32-36a29.45,29.45,0,0,1,16.48,5.11,8,8,0,0,1-9,13.27A13.21,13.21,0,0,0,200,160c-8.82,0-16,9-16,20s7.18,20,16,20a13.57,13.57,0,0,0,8-2.72V192a8,8,0,0,1,0-16h8a8,8,0,0,1,8,8ZM156,152v56a8,8,0,0,1-5.56,7.62A7.91,7.91,0,0,1,148,216a8,8,0,0,1-6.51-3.35L116,177v31a8,8,0,0,1-16,0V152a8,8,0,0,1,14.51-4.65L140,183V152a8,8,0,0,1,16,0ZM48,120a8,8,0,0,0,8-8V40h88V88a8,8,0,0,0,8,8h48v16a8,8,0,0,0,16,0V88a8,8,0,0,0-2.34-5.66l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v72A8,8,0,0,0,48,120ZM160,51.31,188.69,80H160Z',
  FilePdf: 'M224,152a8,8,0,0,1-8,8H192v16h16a8,8,0,0,1,0,16H192v16a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152ZM92,172a28,28,0,0,1-28,28H56v8a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8H64A28,28,0,0,1,92,172Zm-16,0a12,12,0,0,0-12-12H56v24h8A12,12,0,0,0,76,172Zm88,8a36,36,0,0,1-36,36H112a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h16A36,36,0,0,1,164,180Zm-16,0a20,20,0,0,0-20-20h-8v40h8A20,20,0,0,0,148,180ZM40,112V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0ZM160,80h28.69L160,51.31Z',
  Scan: 'M224,40V80a8,8,0,0,1-16,0V48H176a8,8,0,0,1,0-16h40A8,8,0,0,1,224,40ZM80,208H48V176a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H80a8,8,0,0,0,0-16Zm136-40a8,8,0,0,0-8,8v32H176a8,8,0,0,0,0,16h40a8,8,0,0,0,8-8V176A8,8,0,0,0,216,168ZM40,88a8,8,0,0,0,8-8V48H80a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8V80A8,8,0,0,0,40,88ZM80,72h96a8,8,0,0,1,8,8v96a8,8,0,0,1-8,8H80a8,8,0,0,1-8-8V80A8,8,0,0,1,80,72Zm8,96h80V88H88Z',
  SelectionAll: 'M104,40a8,8,0,0,1,8-8h32a8,8,0,0,1,0,16H112A8,8,0,0,1,104,40Zm40,168H112a8,8,0,0,0,0,16h32a8,8,0,0,0,0-16ZM208,32H184a8,8,0,0,0,0,16h24V72a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32Zm8,72a8,8,0,0,0-8,8v32a8,8,0,0,0,16,0V112A8,8,0,0,0,216,104Zm0,72a8,8,0,0,0-8,8v24H184a8,8,0,0,0,0,16h24a16,16,0,0,0,16-16V184A8,8,0,0,0,216,176ZM40,152a8,8,0,0,0,8-8V112a8,8,0,0,0-16,0v32A8,8,0,0,0,40,152Zm32,56H48V184a8,8,0,0,0-16,0v24a16,16,0,0,0,16,16H72a8,8,0,0,0,0-16ZM40,80a8,8,0,0,0,8-8V48H72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,48V72A8,8,0,0,0,40,80ZM176,184H80a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8h96a8,8,0,0,1,8,8v96A8,8,0,0,1,176,184Zm-8-96H88v80h80Z',
  Crop: 'M240,192a8,8,0,0,1-8,8H200v32a8,8,0,0,1-16,0V200H64a8,8,0,0,1-8-8V72H24a8,8,0,0,1,0-16H56V24a8,8,0,0,1,16,0V184H232A8,8,0,0,1,240,192ZM96,72h88v88a8,8,0,0,0,16,0V64a8,8,0,0,0-8-8H96a8,8,0,0,0,0,16Z',
  EyeSlash: 'M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231.05,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z',
  CaretUp: 'M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z',
  MapTrifold: 'M228.92,49.69a8,8,0,0,0-6.86-1.45L160.93,63.52,99.58,32.84a8,8,0,0,0-5.52-.6l-64,16A8,8,0,0,0,24,56V200a8,8,0,0,0,9.94,7.76l61.13-15.28,61.35,30.68A8.15,8.15,0,0,0,160,224a8,8,0,0,0,1.94-.24l64-16A8,8,0,0,0,232,200V56A8,8,0,0,0,228.92,49.69ZM104,52.94l48,24V203.06l-48-24ZM40,62.25l48-12v127.5l-48,12Zm176,131.5-48,12V78.25l48-12Z',
  Pencil: 'M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM51.31,160,136,75.31,152.69,92,68,176.68ZM48,179.31,76.69,208H48Zm48,25.38L79.31,188,164,103.31,180.69,120Zm96-96L147.31,64l24-24L216,84.68Z',
  PencilSimple: 'M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z',
  X: 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
} as const
export type PhName = keyof typeof PH_D
export function Ph({ n, size = 16, ...rest }: { n: PhName; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden {...rest}><path d={PH_D[n]} /></svg>
}

// ---- the tooltip: Marver's inverted tip, after a LONG hover (Nic: shortcuts only on a long hover) -------------------
export type TipSide = 'top' | 'bottom' | 'right' | 'left'
export const TipLabel = ({ label, keys }: { label: ReactNode; keys?: string | string[] }) => (
  <><b>{label}</b>{(Array.isArray(keys) ? keys : keys ? [keys] : []).map((k) => <span key={k} className="k">{k}</span>)}</>
)
const TIP_POS: Record<TipSide, CSSProperties> = {
  top: { left: '50%', top: -7 }, bottom: { left: '50%', top: 'calc(100% + 7px)' },
  right: { left: 'calc(100% + 9px)', top: '50%' }, left: { left: -9, top: '50%' },
}
const TIP_CLS: Record<TipSide, string> = { top: '', bottom: ' below', right: ' right', left: ' dk-left' }
export function HoverTip({ label, keys, side = 'top', children }: { label: ReactNode; keys?: string | string[]; side?: TipSide; children: ReactElement }) {
  const [hover, setHover] = useState(false)
  const t = useRef<number | undefined>(undefined)
  return (
    <span className="dk-tipw"
      onMouseEnter={() => { window.clearTimeout(t.current); t.current = window.setTimeout(() => setHover(true), 700) }}
      onMouseLeave={() => { window.clearTimeout(t.current); setHover(false) }}
      onMouseDown={() => { window.clearTimeout(t.current); setHover(false) }}>
      {cloneElement(children)}
      {hover && <div className={`sh-tip${TIP_CLS[side]}`} style={TIP_POS[side]}><TipLabel label={label} keys={keys} /></div>}
    </span>
  )
}

/** One menu row, the shell's .sh-menu markup: icon, label, the key dimmed at the end. */
export const MI = ({ icon, label, k, on, mv, off, onClick }: { icon?: ReactNode; label: ReactNode; k?: string; on?: boolean; mv?: boolean; off?: boolean; onClick?: () => void }) => (
  <button className={[on ? 'on' : '', mv ? 'mv' : '', off ? 'off' : ''].join(' ').trim() || undefined} disabled={off} onClick={onClick}>
    {icon && <i className="ic">{icon}</i>}<span>{label}</span>{k && <kbd>{k}</kbd>}
  </button>
)

// ---- tools -----------------------------------------------------------------------------------------------------
export type BarTool = DrawTool | 'more'
const ph = (n: PhName, s = 16) => <Ph n={n} size={s} />
/** Every tool: its label, its key (Excalidraw's own letter), its icon. */
export const TOOL: Record<BarTool, { label: string; key?: string; icon: ReactNode }> = {
  hand: { label: 'Hand (pan)', key: 'H', icon: ph('Hand') },
  selection: { label: 'Select', key: 'V', icon: <CursorIcon size={16} /> },
  rectangle: { label: 'Rectangle', key: 'R', icon: ph('Square') },
  diamond: { label: 'Diamond', key: 'D', icon: ph('Diamond') },
  ellipse: { label: 'Ellipse', key: 'O', icon: ph('Circle') },
  arrow: { label: 'Arrow', key: 'A', icon: ph('ArrowRight') },
  line: { label: 'Line', key: 'L', icon: ph('Minus') },
  freedraw: { label: 'Draw', key: 'P', icon: ph('Pencil') },
  text: { label: 'Text', key: 'T', icon: ph('TextT') },
  eraser: { label: 'Eraser', key: 'E', icon: ph('Eraser') },
  image: { label: 'Insert image', key: '9', icon: ph('Image') },
  frame: { label: 'Frame tool', key: 'F', icon: ph('Hash') },
  embeddable: { label: 'Web embed', icon: ph('Code') },
  laser: { label: 'Laser pointer', key: 'K', icon: <LaserIcon size={16} /> },
  more: { label: 'More', icon: ph('DotsThree') },
}
/** Excalidraw's toolbar, in its order (the lock goes first, apart). */
export const MAIN_TOOLS: DrawTool[] = ['hand', 'selection', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'eraser']
/** Excalidraw's More tools. */
export const MORE_TOOLS: DrawTool[] = ['image', 'frame', 'embeddable', 'laser']
/** The canvas bar's set: the most used tools, diamond and line included (Nic, 25 Nov). */
export const CANVAS_TOOLS: DrawTool[] = ['hand', 'selection', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']

// ---- property glyphs ---------------------------------------------------------------------------------------------
export const Ln = ({ w = 2, dash, wob = 0 }: { w?: number; dash?: string; wob?: number }) => (
  <svg width="20" height="12" viewBox="0 0 20 12" aria-hidden><path d={wob ? `M2 ${6 + wob} C7 ${6 - wob * 2} 12 ${6 + wob * 2} 18 ${6 - wob}` : 'M2 6 H18'} stroke="currentColor" strokeWidth={w} strokeDasharray={dash} strokeLinecap="round" fill="none" /></svg>
)
export const Corner = ({ round }: { round?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d={round ? 'M3 14 V8 a5 5 0 0 1 5 -5 H14' : 'M3 14 V3 H14'} stroke="currentColor" strokeWidth={1.6} strokeDasharray="1.6 2" fill="none" strokeLinecap="round" /></svg>
)
export const ArrowKind = ({ k }: { k: 'sharp' | 'round' | 'elbow' }) => (
  <svg width="16" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d={k === 'sharp' ? 'M3 13 L13 3' : k === 'round' ? 'M3 13 Q3 4 13 4' : 'M3 13 H8 V4 H13'} /><path d={k === 'sharp' ? 'M7 3 H13 V9' : 'M10 1.5 L13 4 L10 6.5'} />
  </svg>
)
export const FillIcon = ({ k }: { k: 'hachure' | 'cross' | 'solid' }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <rect x="2" y="2" width="12" height="12" rx="2.5" fill={k === 'solid' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.4} />
    {k !== 'solid' && <path d="M2 10 L10 2 M2 14 L14 2 M6 14 L14 6" stroke="currentColor" strokeWidth={1.1} />}
    {k === 'cross' && <path d="M6 2 L14 10 M2 2 L14 14 M2 6 L10 14" stroke="currentColor" strokeWidth={1.1} />}
  </svg>
)
export const VAlign = ({ k }: { k: 'top' | 'mid' | 'bottom' }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
    {k === 'top' && <><path d="M3 2.5 H13" /><rect x="6" y="5" width="4" height="8" rx="1" /></>}
    {k === 'mid' && <><path d="M2 8 H5 M11 8 H14" /><rect x="6" y="4" width="4" height="8" rx="1" /></>}
    {k === 'bottom' && <><path d="M3 13.5 H13" /><rect x="6" y="3" width="4" height="8" rx="1" /></>}
  </svg>
)
export const Distribute = ({ k }: { k: 'h' | 'v' }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" style={k === 'v' ? { transform: 'rotate(90deg)' } : undefined}>
    <path d="M2 2 V14 M14 2 V14" /><rect x="5.5" y="4.5" width="5" height="7" rx="1" />
  </svg>
)
export const EditPoints = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
    <path d="M2.5 14 C2.5 7 6 4.5 10.5 4.5" /><rect x="10.5" y="2.5" width="4" height="4" rx=".8" /></svg>
)
export const ResetView = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M24 56v48h48" /><path d="M67.59 192A88 88 0 1 0 65.77 65.77L24 104" /></svg>
)

/** Excalidraw 0.18.1's arrowheads (null = none). */
export type Head = 'none' | 'arrow' | 'triangle' | 'triangle_outline' | 'circle' | 'circle_outline' | 'diamond' | 'diamond_outline' | 'bar' | 'crowfoot_one' | 'crowfoot_many' | 'crowfoot_one_or_many'
export const HEADS = {
  basic: ['none', 'arrow', 'triangle', 'triangle_outline'] as Head[],
  more: ['circle', 'circle_outline', 'diamond', 'diamond_outline', 'bar'] as Head[],
  cardinality: ['crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many'] as Head[],
}
export const HEAD_LABEL: Record<Head, string> = {
  none: 'None', arrow: 'Arrow', triangle: 'Triangle', triangle_outline: 'Triangle outline', circle: 'Circle', circle_outline: 'Circle outline',
  diamond: 'Diamond', diamond_outline: 'Diamond outline', bar: 'Bar', crowfoot_one: 'One', crowfoot_many: 'Many', crowfoot_one_or_many: 'One or many',
}
export const HeadIcon = ({ k }: { k: Head }) => {
  const crow = 'M15 6 L22 2.5 M15 6 L22 9.5'
  return (
    <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {k === 'none' ? <><path d="M2 6 H15" /><path d="M17.5 3.5 L21.5 8.5 M21.5 3.5 L17.5 8.5" strokeWidth={1.2} /></>
        : <path d={k === 'circle_outline' || k === 'diamond_outline' ? 'M2 6 H12' : 'M2 6 H22'} />}
      {k === 'arrow' && <path d="M16 2.5 L22 6 L16 9.5" />}
      {(k === 'triangle' || k === 'triangle_outline') && <path d="M16 2.5 L22 6 L16 9.5 Z" fill={k === 'triangle' ? 'currentColor' : 'var(--dk-pop-bg, var(--solid))'} />}
      {k === 'circle' && <circle cx="19" cy="6" r="3" fill="currentColor" />}
      {k === 'circle_outline' && <circle cx="18" cy="6" r="3" />}
      {k === 'diamond' && <path d="M15 6 L18.5 2.5 L22 6 L18.5 9.5 Z" fill="currentColor" />}
      {k === 'diamond_outline' && <path d="M14 6 L17.5 2.5 L21 6 L17.5 9.5 Z" />}
      {k === 'bar' && <path d="M21 2 V10" />}
      {k === 'crowfoot_one' && <path d="M17 2.5 V9.5" />}
      {k === 'crowfoot_many' && <path d={crow} />}
      {k === 'crowfoot_one_or_many' && <><path d="M12 2.5 V9.5" /><path d={crow} /></>}
    </svg>
  )
}

/** Excalidraw's palettes (the stroke row's first is its ink, #1e1e1e - drawn white in dark, as on the canvas). */
export const STROKES = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#6741d9']
export const BGS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff']
export const PALETTE = ['transparent', '#ffffff', '#343a40', '#1e1e1e', '#846358', '#0c8599', '#1971c2', '#6741d9', '#9c36b5', '#c2255c', '#2f9e44', '#099268', '#f08c00', '#e8590c', '#e03131']
export const COLOR_NAME: Record<string, string> = {
  transparent: 'Transparent', '#ffffff': 'White', '#343a40': 'Grey', '#1e1e1e': 'Black', '#846358': 'Bronze', '#0c8599': 'Cyan', '#1971c2': 'Blue',
  '#6741d9': 'Violet', '#9c36b5': 'Grape', '#c2255c': 'Pink', '#2f9e44': 'Green', '#099268': 'Teal', '#f08c00': 'Yellow', '#e8590c': 'Orange', '#e03131': 'Red',
  '#ffc9c9': 'Light red', '#b2f2bb': 'Light green', '#a5d8ff': 'Light blue', '#ffec99': 'Light yellow', '#d0bfff': 'Light violet',
}
export const colorName = (c: string) => COLOR_NAME[c.toLowerCase()] ?? c
/** One swatch; `dark` draws it as the dark canvas shows it (Excalidraw inverts the drawing in dark). */
export const Sw = ({ c, on, cls = '', title, onClick }: { c: string; on?: boolean; cls?: string; title?: string; onClick?: () => void }) => (
  <button type="button" className={`dk-sw${c === 'transparent' ? ' none' : ''}${on ? ' on' : ''}${cls}`} style={c === 'transparent' ? undefined : { background: c }} aria-label={title ?? colorName(c)} title={title ?? colorName(c)} onClick={onClick} />
)

/** Each font's Latin file in Excalidraw 0.18.1's fonts (served at draw-assets/fonts, dev and published): the font picker
 *  shows every name in its own face (the kit). Picked from the package's unicode-range table; pinned with the version. */
const FONT_FILE: Record<number, string> = {
  5: 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
  6: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2',
  7: 'Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2',
  8: 'ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2',
  1: 'Virgil/Virgil-Regular.woff2',
  3: 'Cascadia/CascadiaCode-Regular.woff2',
  9: 'Liberation/LiberationSans-Regular.woff2',
}
let facesAsked = false
/** The CSS family the picker shows a font's name in (a private name, so it never touches the page's own fonts). */
export const previewFamily = (id: number) => (id === 2 ? 'Helvetica, Arial, sans-serif' : FONT_FILE[id] ? `"mv-draw-font-${id}", system-ui` : 'inherit')
/** Register the preview faces once (the first time the font picker opens). */
export function loadPreviewFonts(): void {
  if (facesAsked || typeof FontFace === 'undefined') return
  facesAsked = true
  for (const [id, file] of Object.entries(FONT_FILE)) {
    const face = new FontFace(`mv-draw-font-${id}`, `url(${ROUTE}/draw-assets/fonts/${file}) format("woff2")`)
    document.fonts.add(face)
    void face.load().catch(() => { /* the name shows in the UI font */ })
  }
}

/** The fonts Excalidraw 0.18.1 offers, by its id. The three quick picks first. */
export const FONTS: { id: number; name: string; kind: 'hand' | 'normal' | 'code' }[] = [
  { id: 5, name: 'Excalifont', kind: 'hand' }, { id: 6, name: 'Nunito', kind: 'normal' }, { id: 8, name: 'Comic Shanns', kind: 'code' },
  { id: 7, name: 'Lilita One', kind: 'normal' }, { id: 1, name: 'Virgil', kind: 'hand' }, { id: 2, name: 'Helvetica', kind: 'normal' },
  { id: 3, name: 'Cascadia', kind: 'code' }, { id: 9, name: 'Liberation Sans', kind: 'normal' },
]

/** A shortcut as Mac glyphs in Apple's order, ⌃⌥⇧⌘ then the key (spec 39 A6) - one formatter for the right-click menu and
 *  the panel's tips, so the two never disagree. `combo` reads like 'Mod+Alt+]' or 'Shift+H' (Mod is ⌘). */
export function keyGlyphs(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  const has = (m: string) => parts.some((p) => p.toLowerCase() === m)
  const key = parts.filter((p) => !['mod', 'cmd', 'ctrl', 'alt', 'option', 'shift'].includes(p.toLowerCase())).pop() ?? ''
  const named: Record<string, string> = { enter: '↵', backspace: '⌫', delete: '⌫', escape: 'esc', left: '←', right: '→', up: '↑', down: '↓' }
  const k = named[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return `${has('ctrl') ? '⌃' : ''}${has('alt') || has('option') ? '⌥' : ''}${has('shift') ? '⇧' : ''}${has('mod') || has('cmd') ? '⌘' : ''}${k}`
}