export interface GateCheck {
  tool: string;
  action: string;
  args: Record<string, unknown>;
  chatId?: string;
}

export interface GateService {
  confirm(check: GateCheck): Promise<boolean>;
}
