import type { DbClient } from "@/lib/db-contract";
import { buildFullAddress } from "@/lib/travel/distance";
import { buildDispatchRouteLegs, type DispatchRouteReadiness } from "./routing";
import { availableMinutesInRange, loadAvailabilityForAccount, type AvailabilityWindow } from "@/lib/workforce/availability";
import { loadTechnicianSkills, type TechnicianSkill } from "@/lib/workforce/skills";
import { loadCurrentVehicleAssignments } from "@/lib/workforce/vehicle-assignment";
import { loadCompanyMemberDirectory } from "@/lib/workforce/member-directory";

export interface DispatchTechnicianCapacity {
  userId: string;
  name: string;
  scheduledMinutes: number;
  visitCount: number;
  nominalCapacityMinutes: number;
  availableCapacityMinutes: number;
  capacitySource: "availability" | "nominal_fallback";
  utilizationPct: number;
  skills: TechnicianSkill[];
  assignedVehicle: { id: string; name: string; plate: string | null } | null;
}

export interface DispatchVisit {
  id: string;
  jobId: string;
  workOrderId: string | null;
  jobTitle: string;
  clientName: string | null;
  propertyAddress: string | null;
  assignedUserId: string | null;
  technicianName: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  propertyLatitude: number | null;
  propertyLongitude: number | null;
  plannedTravelMiles: number | null;
  plannedTravelMinutes: number | null;
  plannedTravelSource: string | null;
  routeFromPrevious: {
    fromVisitId: string;
    estimatedMiles: number | null;
    estimatedMinutes: number | null;
    gapMinutes: number;
    slackMinutes: number | null;
    readiness: DispatchRouteReadiness;
  } | null;
}

type DbVisit = Record<string, unknown> & {
  id: string;
  job_id: string;
  work_order_id: string | null;
  job_title: string;
  client_name: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  property_latitude: number | null;
  property_longitude: number | null;
  planned_travel_miles: number | null;
  planned_travel_minutes: number | null;
  planned_travel_source: string | null;
  assigned_user_id: string | null;
  technician_name: string | null;
  scheduled_start: string | Date;
  scheduled_end: string | Date;
  status: string;
};

type DbTech = Record<string, unknown> & { id: string; full_name: string | null; email: string | null };

export function minutesBetween(start: string | Date, end: string | Date): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0, Math.round(ms / 60_000));
}

export function buildCapacity(
  technicians: DbTech[],
  visits: DbVisit[],
  planningDays: number,
  rangeStart: Date,
  rangeEnd: Date,
  availability: AvailabilityWindow[] = [],
  skillsByUser: Map<string, TechnicianSkill[]> = new Map(),
  vehiclesByUser: Map<string, { id: string; name: string; plate: string | null }> = new Map(),
): DispatchTechnicianCapacity[] {
  const nominalCapacityMinutes = Math.max(1, planningDays) * 8 * 60;
  const byUser = new Map<string, { minutes: number; visits: number }>();
  for (const visit of visits) {
    if (!visit.assigned_user_id || ["cancelled", "completed"].includes(visit.status)) continue;
    const current = byUser.get(visit.assigned_user_id) ?? { minutes: 0, visits: 0 };
    current.minutes += minutesBetween(visit.scheduled_start, visit.scheduled_end);
    current.visits += 1;
    byUser.set(visit.assigned_user_id, current);
  }
  return technicians.map((tech): DispatchTechnicianCapacity => {
    const load = byUser.get(tech.id) ?? { minutes: 0, visits: 0 };
    const userAvailability = availability.filter((window) => window.userId === tech.id);
    const configuredMinutes = availableMinutesInRange(userAvailability, rangeStart, rangeEnd);
    const availableCapacityMinutes = configuredMinutes == null ? nominalCapacityMinutes : configuredMinutes;
    return {
      userId: tech.id,
      name: tech.full_name?.trim() || tech.email?.trim() || "Technician",
      scheduledMinutes: load.minutes,
      visitCount: load.visits,
      nominalCapacityMinutes,
      availableCapacityMinutes,
      capacitySource: configuredMinutes == null ? "nominal_fallback" : "availability",
      utilizationPct: availableCapacityMinutes > 0 ? Math.round((load.minutes / availableCapacityMinutes) * 100) : (load.minutes > 0 ? 999 : 0),
      skills: skillsByUser.get(tech.id) ?? [],
      assignedVehicle: vehiclesByUser.get(tech.id) ?? null,
    };
  }).sort((a, b) => a.utilizationPct - b.utilizationPct || a.name.localeCompare(b.name));
}

export async function loadDispatchBoard(client: DbClient, accountId: string, rangeStart: Date, rangeEnd: Date) {
  const technicians: DbTech[] = (await loadCompanyMemberDirectory(client, accountId))
    .map(({ id, full_name, email }) => ({ id, full_name, email }));
  const [availability, skillsByUser, vehicleAssignments] = await Promise.all([
    loadAvailabilityForAccount(client, accountId),
    loadTechnicianSkills(client, accountId),
    loadCurrentVehicleAssignments(client, accountId),
  ]);
  const vehiclesByUser = new Map(vehicleAssignments.map((assignment) => [assignment.userId, { id: assignment.vehicleId, name: assignment.vehicleName, plate: assignment.plate }]));

  const fieldVehiclesResult = await client.query<Record<string, unknown> & { id: string; nickname: string; plate: string | null }>(
    `SELECT id, nickname, plate FROM vehicles WHERE account_id = $1 AND is_active = true AND kind <> 'trailer' ORDER BY nickname ASC`,
    [accountId],
  );
  const fieldVehicles = fieldVehiclesResult.rows;

  const visitsResult = await client.query<DbVisit>(
    `SELECT v.id, v.job_id, v.work_order_id, v.assigned_user_id,
            v.scheduled_start, v.scheduled_end, v.status,
            j.title AS job_title, c.name AS client_name,
            p.address AS property_address, p.city AS property_city, p.state AS property_state,
            p.zip AS property_zip, p.latitude AS property_latitude, p.longitude AS property_longitude,
            ts.one_way_miles AS planned_travel_miles, ts.one_way_minutes AS planned_travel_minutes,
            ts.calculation_source AS planned_travel_source,
            u.full_name AS technician_name
       FROM visits v
       JOIN jobs j ON j.id = v.job_id AND j.account_id = v.account_id
       LEFT JOIN clients c ON c.id = j.client_id AND c.account_id = v.account_id
       LEFT JOIN properties p ON p.id = j.property_id AND p.account_id = v.account_id
       LEFT JOIN work_orders wo ON wo.id = v.work_order_id AND wo.account_id = v.account_id
       LEFT JOIN travel_calculation_snapshots ts ON ts.id = COALESCE(v.travel_snapshot_id, wo.travel_snapshot_id) AND ts.account_id = v.account_id
       LEFT JOIN users u ON u.id = v.assigned_user_id
      WHERE v.account_id = $1
        AND v.scheduled_start >= $2
        AND v.scheduled_start < $3
        AND v.status NOT IN ('cancelled','completed')
      ORDER BY v.scheduled_start ASC`,
    [accountId, rangeStart.toISOString(), rangeEnd.toISOString()],
  );
  const visits = visitsResult.rows;

  const planningDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000));
  const normalized = visits.map((visit) => ({
    ...visit,
    scheduledStart: visit.scheduled_start instanceof Date ? visit.scheduled_start.toISOString() : String(visit.scheduled_start),
    scheduledEnd: visit.scheduled_end instanceof Date ? visit.scheduled_end.toISOString() : String(visit.scheduled_end),
  }));
  const routeLegs = buildDispatchRouteLegs(normalized.map((visit) => ({
    id: visit.id,
    assignedUserId: visit.assigned_user_id,
    scheduledStart: visit.scheduledStart,
    scheduledEnd: visit.scheduledEnd,
    latitude: visit.property_latitude == null ? null : Number(visit.property_latitude),
    longitude: visit.property_longitude == null ? null : Number(visit.property_longitude),
  })));
  const routeByDestination = new Map(routeLegs.map((leg) => [leg.toVisitId, leg]));

  return {
    fieldVehicles: fieldVehicles.map((vehicle) => ({ id: vehicle.id, name: vehicle.nickname, plate: vehicle.plate })),
    technicians: buildCapacity(technicians, visits, planningDays, rangeStart, rangeEnd, availability, skillsByUser, vehiclesByUser),
    visits: normalized.map((visit): DispatchVisit => {
      const route = routeByDestination.get(visit.id) ?? null;
      return {
        id: visit.id,
        jobId: visit.job_id,
        workOrderId: visit.work_order_id,
        jobTitle: visit.job_title,
        clientName: visit.client_name,
        propertyAddress: buildFullAddress({ address: visit.property_address, city: visit.property_city, state: visit.property_state, zip: visit.property_zip }) || null,
        assignedUserId: visit.assigned_user_id,
        technicianName: visit.technician_name,
        scheduledStart: visit.scheduledStart,
        scheduledEnd: visit.scheduledEnd,
        status: visit.status,
        propertyLatitude: visit.property_latitude == null ? null : Number(visit.property_latitude),
        propertyLongitude: visit.property_longitude == null ? null : Number(visit.property_longitude),
        plannedTravelMiles: visit.planned_travel_miles == null ? null : Number(visit.planned_travel_miles),
        plannedTravelMinutes: visit.planned_travel_minutes == null ? null : Number(visit.planned_travel_minutes),
        plannedTravelSource: visit.planned_travel_source,
        routeFromPrevious: route ? {
          fromVisitId: route.fromVisitId,
          estimatedMiles: route.estimatedMiles,
          estimatedMinutes: route.estimatedMinutes,
          gapMinutes: route.gapMinutes,
          slackMinutes: route.slackMinutes,
          readiness: route.readiness,
        } : null,
      };
    }),
  };
}
