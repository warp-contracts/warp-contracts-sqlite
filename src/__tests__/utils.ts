import { SqliteContractCache } from "../SqliteContractCache";
import { SqliteCacheOptions } from "../SqliteCacheOptions";
import fs from "fs";

export const getContractId = (i: number) => `contract${i}`.padStart(43, "0");

export const getSortKey = (j: number) =>
  `${j
    .toString()
    .padStart(
      12,
      "0"
    )},1643210931796,81e1bea09d3262ee36ce8cfdbbb2ce3feb18a717c3020c47d206cb8ecb43b767`;

export const rmCacheDB = function (dbName: string): () => any {
  return () => {
    if (fs.existsSync(`./cache/warp/sqlite/${dbName}`)) {
      fs.rmSync(`./cache/warp/sqlite/${dbName}`, { recursive: true });
    }
  };
};

export const cache = async function (
  dbName: string,
  numContracts: number,
  numRepeatingEntries: number,
  opt?: SqliteCacheOptions
): Promise<SqliteContractCache<any>> {
  const sqliteOptions: SqliteCacheOptions = opt
    ? opt
    : {
        maxEntriesPerContract: 100 * numRepeatingEntries,
      };
  const sut = new SqliteContractCache<any>(
    { dbLocation: `./cache/warp/sqlite/${dbName}`, inMemory: true },
    sqliteOptions
  );

  for (let i = 0; i < numContracts; i++) {
    for (let j = 0; j < numRepeatingEntries; j++) {
      await sut.put(
        {
          key: getContractId(i),
          sortKey: getSortKey(j),
        },
        { result: `contract${i}:${j}` }
      );
    }
  }

  return sut;
};
