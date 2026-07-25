import {describe,it,expect} from "vitest";
import {formatAmount,deltaTone,sparkPath} from "./format";

describe("formatAmount",()=>{
  it("groups thousands with 2 decimals",()=>{expect(formatAmount(12480.5)).toBe("12,480.50");});
  it("handles zero",()=>{expect(formatAmount(0)).toBe("0.00");});
  it("respects custom decimals",()=>{expect(formatAmount(1.23456,4)).toBe("1.2346");});
});
describe("deltaTone",()=>{
  it("positive -> pos",()=>{expect(deltaTone(2.4)).toBe("pos");});
  it("negative -> neg",()=>{expect(deltaTone(-1)).toBe("neg");});
  it("zero -> flat",()=>{expect(deltaTone(0)).toBe("flat");});
});
describe("sparkPath",()=>{
  it("maps points into a viewBox path",()=>{const d=sparkPath([1,2,3],100,20);expect(d.startsWith("M")).toBe(true);expect(d).toContain("L");});
  it("empty -> empty string",()=>{expect(sparkPath([],100,20)).toBe("");});
});
