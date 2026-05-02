import JSON5 from "json5";

export const stringifyCompactJson5 = (value: unknown): string | undefined => {
    if (value == null) {
        return undefined;
    }

    try {
        return JSON5.stringify(value);
    } catch {
        return String(value);
    }
};

export const stringifySearchValueAsJson5 = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return stringifyCompactJson5(value) ?? "";
};
