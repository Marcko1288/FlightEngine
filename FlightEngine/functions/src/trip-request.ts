import {rapidQuery} from "./rapid-request";
import {serpStops} from "./provider-response";
import type {FlightQuery} from "./round-trip-search";

export function tripRequest(provider:string,key:string,trip:FlightQuery,travelers:number,maxStops:number,currency:string){
 if(provider==="SerpApi"){
  const q=new URLSearchParams({engine:"google_flights",gl:"it",hl:"it",currency,type:trip.returnDate?"1":"2",adults:String(travelers),stops:serpStops(maxStops),api_key:key,departure_id:trip.origin,arrival_id:trip.destination,outbound_date:trip.departureDate});
  if(trip.returnDate)q.set("return_date",trip.returnDate);
  return{url:"https://serpapi.com/search.json?"+q,init:{} as RequestInit,kind:"serp" as const};
 }
 const headers={"x-rapidapi-key":key,"x-rapidapi-host":"google-flights2.p.rapidapi.com"};
 const base="https://google-flights2.p.rapidapi.com/api/v1/";
 const q=rapidQuery(trip.origin,trip.destination,trip.departureDate,travelers,currency);
 if(trip.returnDate)q.set("return_date",trip.returnDate);
 return{url:base+"searchFlights?"+q,init:{headers},kind:"rapid" as const};
}
