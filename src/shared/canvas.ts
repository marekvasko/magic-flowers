// Kreslenie do 2D plátna, ako ho používajú zdieľané moduly (sprity pavúkov, …): len volania, ktoré naozaj robia.
// Prehliadačový CanvasRenderingContext2D tento tvar spĺňa; server a testy typy DOM nepotrebujú.
export interface Canvas2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  shadowColor: string;
  shadowBlur: number;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  translate(x: number, y: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}
