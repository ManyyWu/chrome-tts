import type { ExtensionError, PlaybackState } from "../shared/models";
import { endGfwSiteIntegration } from "./sites/end-gfw-site";
import { youtubeSiteIntegration } from "./sites/youtube-site";

/** 浮动条只消费该配置，不感知具体网站、DOM 选择器或 URL 规则。 */
export interface SiteToolPanelConfig {
  title: string;
  actions: readonly SiteToolAction[];
}

export interface SiteToolAction {
  id: string;
  label: string;
  description: string;
  isAvailable?(): boolean;
  activate(): void;
}

/** 站点适配器可通过上下文读取播放位置并复用内容脚本的错误提示。 */
export interface SiteIntegrationContext {
  getCurrentTextElement(): HTMLElement | null;
  reportError(error: ExtensionError): void;
  showNotice(message: string): void;
  playCaption(text: string): void;
  stopPlayback(): void;
  subscribePlaybackState(listener: (state: PlaybackState) => void): () => void;
}

/** 单个页面上的站点功能实例，预留启动和销毁钩子供动态网站使用。 */
export interface SiteIntegrationInstance {
  toolPanel?: SiteToolPanelConfig;
  startExpanded?: boolean;
  start?(): void;
  stop?(): void;
}

/** 每个特殊网站实现此接口，通用播放逻辑无需了解网站名称。 */
export interface SiteIntegration {
  readonly id: string;
  matches(url: URL): boolean;
  create(
    url: URL,
    context: SiteIntegrationContext,
  ): SiteIntegrationInstance;
}

/** 新增网站适配时只需新增独立文件并在此注册。顺序代表匹配优先级。 */
const SITE_INTEGRATIONS: readonly SiteIntegration[] = [
  endGfwSiteIntegration,
  youtubeSiteIntegration,
];

export function resolveSiteIntegration(
  url: URL,
  context: SiteIntegrationContext,
): SiteIntegrationInstance | null {
  const integration = SITE_INTEGRATIONS.find((candidate) =>
    candidate.matches(url)
  );
  return integration?.create(url, context) ?? null;
}
