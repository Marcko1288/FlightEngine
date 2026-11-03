// Parameters verified against the successful RapidAPI playground request.
export function rapidQuery(origin:string,destination:string,date:string,travelers:number,currency:string){
 return new URLSearchParams({departure_id:origin,arrival_id:destination,outbound_date:date,travel_class:"ECONOMY",adults:String(travelers),show_hidden:"1",currency,language_code:"it",country_code:"IT",search_type:"best"});
}
