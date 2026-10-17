// Help & feedback (v0.8b — API.md §1.69 #81b). Tickets land in the admin
// inbox; replies arrive as ordinary messages in the per-user "Bored Chat
// Support" conversation (sender_id NULL — the brand, never a named admin).
import type {
  CreateSupportTicketRequest,
  SupportTicket,
  SupportTicketResponse,
  SupportTicketsResponse,
} from '@socialchat/shared';
import { api } from './api';

export async function createSupportTicket(req: CreateSupportTicketRequest): Promise<SupportTicket> {
  const res = await api.post<SupportTicketResponse>('/api/support/tickets', req);
  return res.ticket;
}

export async function listMySupportTickets(): Promise<SupportTicket[]> {
  const res = await api.get<SupportTicketsResponse>('/api/support/tickets');
  return res.tickets;
}
