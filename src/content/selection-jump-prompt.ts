import type { PageSelectionPosition } from "./adapters/types";

type JumpHandler = (position: PageSelectionPosition) => void;

/** 在网页选区附近显示一个隔离样式的“跳转”按钮。 */
export class SelectionJumpPrompt {
  private readonly host: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private position: PageSelectionPosition | null = null;

  public constructor(private readonly onJump: JumpHandler) {
    this.host = document.createElement("div");
    this.host.id = "chrome-tts-selection-jump-prompt";
    this.host.hidden = true;
    const shadow = this.host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        position: fixed;
        z-index: 2147483647;
        display: block;
      }
      :host([hidden]) {
        display: none;
      }
      button {
        min-width: 58px;
        height: 34px;
        padding: 0 14px;
        border: 1px solid rgb(22 132 91 / 45%);
        border-radius: 17px;
        color: #fff;
        background: #16845b;
        box-shadow: 0 5px 16px rgb(0 0 0 / 22%);
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      button:hover {
        background: #116b4a;
      }
      button:focus-visible {
        outline: 3px solid rgb(52 211 153 / 45%);
        outline-offset: 2px;
      }
    `;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.textContent = "跳转";
    this.button.setAttribute("aria-label", "从选择位置开始播放");
    this.button.addEventListener("pointerdown", (event) => {
      // 防止按下按钮时网页清除选区并触发新的选区处理。
      event.preventDefault();
      event.stopPropagation();
    });
    this.button.addEventListener("click", () => {
      const position = this.position;
      this.hide();
      if (position) {
        this.onJump(position);
      }
    });
    shadow.append(style, this.button);
    document.documentElement.append(this.host);

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(this.host)) {
          this.hide();
        }
      },
      true,
    );
    window.addEventListener("scroll", () => this.hide(), true);
    window.addEventListener("resize", () => this.hide());
  }

  /** 根据选区矩形定位，确保按钮完整留在当前视口内。 */
  public show(rect: DOMRect, position: PageSelectionPosition): void {
    this.position = position;
    this.host.hidden = false;
    const margin = 8;
    const width = this.host.offsetWidth;
    const height = this.host.offsetHeight;
    const preferredLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.min(
      window.innerWidth - width - margin,
      Math.max(margin, preferredLeft),
    );
    const belowTop = rect.bottom + margin;
    const top =
      belowTop + height <= window.innerHeight - margin
        ? belowTop
        : Math.max(margin, rect.top - height - margin);
    this.host.style.left = `${left}px`;
    this.host.style.top = `${top}px`;
  }

  public hide(): void {
    this.host.hidden = true;
    this.position = null;
  }
}
