import path from "path";
import { getFs } from "./b3fs";

const b3path = path;

declare module "path" {
  interface PlatformPath {
    basenameWithoutExt(path: string): string;
    posixPath(path: string): string;
    lsdir(path: string, recursive?: boolean): string[];
  }
}

path.basenameWithoutExt = (str: string) => {
  return b3path.basename(str, b3path.extname(str));
};

path.posixPath = (str: string) => {
  return path.normalize(str).replace(/\\/g, "/");
};

path.lsdir = (dir: string, recursive?: boolean) => {
  const fs = getFs();
  return fs
    .readdirSync(dir, { recursive })
    .map((file) => b3path.posixPath(dir + "/" + file))
    .sort();
};

export default b3path;
