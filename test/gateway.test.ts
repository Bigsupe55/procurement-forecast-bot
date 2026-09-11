import { describe, it, expect } from "vitest";
import { normalizeGatewayRender } from "../src/sources/acquisitionGatewayForecast.js";

// A real render object captured from the live Gateway export (USDA Forest Service).
const usda = {
  nid: "46964",
  title: "North Mills River Campground Helene Restoration",
  body: "<p>Campground restoration from damage incurred from Hurricane Helene. Includes paving.</p>\n",
  field_result_id: "Department of Agriculture",
  field_organization: "Forest Service",
  field_naics_code: "236220",
  field_estimated_contract_v_max: "$2M - $4.9M",
  field_estimated_award_fy: "2026",
  field_estimated_award_fy_qtr: "4th (July 1 - September 30)",
  field_estimated_solicitation_dat: "07/02/2026",
  field_requirement_status: "New Requirement",
  field_point_of_contact_name: "WESLEY MCCALL",
  field_advisor_info_name: "ASHLEY THOMPSON",
  field_acquisition_strategy: "To Be Determined",
  field_award_status: "Evaluation Stage",
  field_place_of_performance_administrative_area: "North Carolina",
  status: "Yes",
};

describe("normalizeGatewayRender", () => {
  it("maps core fields from a real record", () => {
    const o = normalizeGatewayRender(usda);
    expect(o.source).toBe("acquisition-gateway");
    expect(o.id).toBe("46964");
    expect(o.agency).toBe("Department of Agriculture");
    expect(o.bureau).toBe("Forest Service");
    expect(o.naics).toBe("236220");
    expect(o.estValue).toBe("$2M - $4.9M");
    expect(o.awardQuarter).toBe("FY 2026 Q4");
    expect(o.solicitationDate).toBe("07/02/2026");
    expect(o.oppType).toBe("New");
  });

  it("strips HTML from the description", () => {
    const o = normalizeGatewayRender(usda);
    expect(o.description).not.toContain("<p>");
    expect(o.description).toContain("Campground restoration");
  });

  it("drops placeholder values like 'To Be Determined'", () => {
    const o = normalizeGatewayRender(usda);
    expect(o.contractVehicle).toBeUndefined();
  });

  it("classifies a follow-on requirement as a Recompete", () => {
    const o = normalizeGatewayRender({ ...usda, field_requirement_status: "Follow-on Requirement" });
    expect(o.oppType).toBe("Recompete");
  });

  it("extracts a clean 6-digit NAICS from a messy value", () => {
    const o = normalizeGatewayRender({ ...usda, field_naics_code: "541512 - Computer Systems Design" });
    expect(o.naics).toBe("541512");
  });
});
