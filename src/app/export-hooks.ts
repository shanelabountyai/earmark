import { moduleExportTables } from '@/app/modules';
import type { ExportTable } from '@/core/tenancy/export';

// Clone-owned (v1.6.0), like org-hooks.ts: which tables a data export holds beyond the template's core ones
// (addendum §5). Add one entry per org-owned table, selecting only columns that are safe to hand over: never a
// sealed column, token hash or recovery code (INV-34 scans the output). Every query runs inside withOrg.
//   { name: 'Booking', rows: (tx, orgId) => tx.booking.findMany({ where: { orgId }, select: { id: true, startsAt: true } }) },
export const exportTables: readonly ExportTable[] = [
  ...moduleExportTables,
  // Earmark (PRD §6): the whole ledger, every column. None of these tables holds a sealed value, token or secret.
  { name: 'OrgSettings', rows: (tx, orgId) => tx.orgSettings.findMany({ where: { orgId } }) },
  { name: 'FiscalYear', rows: (tx, orgId) => tx.fiscalYear.findMany({ where: { orgId } }) },
  { name: 'Period', rows: (tx, orgId) => tx.period.findMany({ where: { orgId } }) },
  { name: 'Program', rows: (tx, orgId) => tx.program.findMany({ where: { orgId } }) },
  { name: 'Campaign', rows: (tx, orgId) => tx.campaign.findMany({ where: { orgId } }) },
  { name: 'BudgetLine', rows: (tx, orgId) => tx.budgetLine.findMany({ where: { orgId } }) },
  { name: 'Agency', rows: (tx, orgId) => tx.agency.findMany({ where: { orgId } }) },
  { name: 'GuestMembership', rows: (tx, orgId) => tx.guestMembership.findMany({ where: { orgId } }) },
  { name: 'Seat', rows: (tx, orgId) => tx.seat.findMany({ where: { orgId } }) },
  { name: 'SeatHolder', rows: (tx, orgId) => tx.seatHolder.findMany({ where: { orgId } }) },
  { name: 'SpendRequest', rows: (tx, orgId) => tx.spendRequest.findMany({ where: { orgId } }) },
  { name: 'ApprovalStep', rows: (tx, orgId) => tx.approvalStep.findMany({ where: { orgId } }) },
  { name: 'Commitment', rows: (tx, orgId) => tx.commitment.findMany({ where: { orgId } }) },
  { name: 'Invoice', rows: (tx, orgId) => tx.invoice.findMany({ where: { orgId } }) },
  { name: 'InvoiceMatch', rows: (tx, orgId) => tx.invoiceMatch.findMany({ where: { orgId } }) },
  { name: 'Reallocation', rows: (tx, orgId) => tx.reallocation.findMany({ where: { orgId } }) },
  { name: 'VarianceNote', rows: (tx, orgId) => tx.varianceNote.findMany({ where: { orgId } }) },
];

// An org-owned table left out on purpose, with the reason. INV-34 fails on any model with an orgId column that is in
// neither list, so a new table cannot silently drop out of every export.
export const exportSkipped: Readonly<Record<string, string>> = {};
