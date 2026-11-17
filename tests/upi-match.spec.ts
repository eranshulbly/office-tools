import { describe, it, expect } from "vitest";
import { extractVpa, extractPayerAccount } from "../src/lib/upi";
import { buildMatchIndex, matchLine, tierOf, type VpaMapping } from "../src/lib/upi-match";

// Narrations copied from a real Oct 2026 HDFC statement (masking began 14/10).
const BEFORE = "UPI-924020001260349-9758963148@PTAXIS-627557074421-SENT USING PAYTM UPI";
const AFTER = "UPI-924020001260349-******3148@PTAXIS-628906129405-SENT USING PAYTM UPI";

const line = (n: string) => ({ vpa: extractVpa(n), account: extractPayerAccount(n) });

const MAPS: VpaMapping[] = [
  { upi_id: "9758963148@PTAXIS", dealer_name: "MS Diesel" },
  { upi_id: "9359118695-3@AXL", dealer_name: "Sartaj Auto" },
  { upi_id: "7208221295-3@AXL", dealer_name: "Other Dealer" },
  { upi_id: "9719305023@AXL", dealer_name: "Ravi Motors" },
  { upi_id: "8410501725-2@AXL", dealer_name: "A.K. Motor", review: "Ambiguous - verify", alt_dealer: "Usman Spare" },
  { upi_id: "MDARTS@YBL", dealer_name: "M D Automobile" },
];

describe("narration parsing", () => {
  it("reads payer account and masked VPA", () => {
    expect(extractPayerAccount(AFTER)).toBe("924020001260349");
    expect(extractVpa(AFTER)).toBe("******3148@PTAXIS");
    expect(extractPayerAccount("IB FUNDS TRANSFER DR-50200043794433-ANMOL")).toBeNull();
  });
});

describe("matchLine", () => {
  it("confirms an exact unmasked VPA", () => {
    const m = matchLine(line(BEFORE), buildMatchIndex(MAPS, []));
    expect(m).toMatchObject({ status: "confirmed", dealer: "MS Diesel", score: 100 });
  });

  it("confirms a masked line by saved payer account", () => {
    const idx = buildMatchIndex(MAPS, [{ payer_account: "924020001260349", dealer_name: "MS Diesel" }]);
    expect(matchLine(line(AFTER), idx)).toMatchObject({ status: "confirmed", dealer: "MS Diesel" });
  });

  it("learns the payer account from an unmasked line in the same statement", () => {
    const lines = [line(BEFORE), line(AFTER)];
    const idx = buildMatchIndex(MAPS, [], lines);
    expect(idx.learned.get("924020001260349")?.dealer_name).toBe("MS Diesel");
    expect(matchLine(lines[1], idx)).toMatchObject({ status: "confirmed", dealer: "MS Diesel" });
  });

  it("does not learn an account that paid as two dealers", () => {
    const a = "UPI-111111111-9758963148@PTAXIS-1-X";
    const b = "UPI-111111111-9719305023@AXL-2-X";
    const idx = buildMatchIndex(MAPS, [], [line(a), line(b)]);
    expect(idx.learned.has("111111111")).toBe(false);
  });

  it("suggests a masked VPA by length + visible tail + same handle", () => {
    const m = matchLine(line("UPI-555555555-******3148@PTAXIS-1-X"), buildMatchIndex(MAPS, []));
    expect(m.status).toBe("suggested");
    expect(m.dealer).toBe("MS Diesel");
    expect(m.score).toBe(80);
    expect(tierOf(m, 30)).toBe("likely");
  });

  it("splits confidence when two dealers fit the mask equally", () => {
    const m = matchLine(line("UPI-555555555-********95-3@AXL-1-X"), buildMatchIndex(MAPS, []));
    expect(m.candidates.map((c) => c.dealer).sort()).toEqual(["Other Dealer", "Sartaj Auto"]);
    // 55 fit + 25 same handle − 10 (only "95" visible) = 70 each → 70²/140 = 35.
    expect(m.candidates[0].score).toBe(35);
    expect(m.candidates[1].score).toBe(35);
    expect(tierOf(m, 30)).toBe("possible");
    expect(tierOf(m, 50)).toBe("unmapped");
  });

  it("scores distinctive letters higher than digits", () => {
    // 55 fit + 25 same handle + 10 letters = 90.
    const m = matchLine(line("UPI-555555555-**ARTS@YBL-1-X"), buildMatchIndex(MAPS, []));
    expect(m).toMatchObject({ dealer: "M D Automobile", score: 90 });
  });

  it("suggests the same unmasked ID on another app", () => {
    const m = matchLine(line("UPI-555555555-9719305023@YBL-1-X"), buildMatchIndex(MAPS, []));
    expect(m).toMatchObject({ status: "suggested", dealer: "Ravi Motors", score: 85 });
  });

  it("suggests a flagged mapping and its alt dealer, never confirms", () => {
    const m = matchLine(line("UPI-555555555-8410501725-2@AXL-1-X"), buildMatchIndex(MAPS, []));
    expect(m.status).toBe("suggested");
    expect(m.candidates.map((c) => c.dealer)).toEqual(["A.K. Motor", "Usman Spare"]);
  });

  it("a payer account seen on a flagged mapping beats look-alike VPAs", () => {
    // 9149181633 is flagged; a different dealer's 8218441633 also fits ******1633.
    const maps: VpaMapping[] = [
      { upi_id: "9149181633@YBL", dealer_name: "Bareilly Raj", review: "Ambiguous - verify", alt_dealer: "Bareilly Auto" },
      { upi_id: "8218441633@UPI", dealer_name: "Fauji Tractor" },
    ];
    const lines = [
      line("UPI-00000042954981756-9149181633@AXL-1-X"),
      line("UPI-00000042954981756-******1633@YBL-2-X"),
    ];
    const idx = buildMatchIndex([...maps, { upi_id: "9149181633@AXL", dealer_name: "Bareilly Raj", review: "Ambiguous - verify", alt_dealer: "Bareilly Auto" }], [], lines);
    expect(idx.learned.get("00000042954981756")?.flagged).toBe(true);
    const m = matchLine(lines[1], idx);
    expect(m.status).toBe("suggested");
    expect(m.candidates.map((c) => c.dealer)).toEqual(["Bareilly Raj", "Bareilly Auto"]);
  });

  it("never suggests a placeholder dealer by pattern", () => {
    const maps: VpaMapping[] = [{ upi_id: "9193908486-2@AXL", dealer_name: "(as per details)", review: "Placeholder - classify in Tally" }];
    const m = matchLine(line("UPI-555555555-********86-2@AXL-1-X"), buildMatchIndex(maps, []));
    expect(m.status).toBe("unmapped");
  });

  it("leaves an unknown masked VPA unmapped", () => {
    const m = matchLine(line("UPI-555555555-******0000@KOTAKBANK-1-X"), buildMatchIndex(MAPS, []));
    expect(m.status).toBe("unmapped");
  });
});
