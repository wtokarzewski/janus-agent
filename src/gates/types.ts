export interface GateCheck {
  tool: string;
  action: string;
  args: Record<string, unknown>;
  chatId?: string;
  userId?: string;
}

export interface GateService {
  confirm(check: GateCheck): Promise<boolean>;
}

export interface GateAuditEntry {
  tool: string;
  action: string;
  approved: boolean;
  userId?: string;
  chatId?: string;
}
